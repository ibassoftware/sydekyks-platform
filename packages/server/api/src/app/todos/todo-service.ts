import { createHash } from 'node:crypto'
import { apId, Permission } from '@activepieces/core-utils'
import { FlowRunStatus, PauseType, PlatformRole, Principal, PrincipalType, UserStatus, WorkerJobType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { databaseConnection } from '../database/database-connection'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { domainHelper } from '../helper/domain-helper'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { HostingDispatch, HostingDispatchEntity } from '../hosting/hosting-dispatch-entity'
import { hostingTransactions as tx } from '../hosting/hosting-transactions'
import { ProjectEntity } from '../project/project-entity'
import { communityAuthorization } from '../sydekyks-community/project-access'
import { UserEntity } from '../user/user-entity'
import { resumeService } from '../waitpoints/resume-service'
import { WaitpointEntity } from '../waitpoints/waitpoint-entity'
import { WaitpointStatus } from '../waitpoints/waitpoint-types'
import { CatalogueTodo, CatalogueTodoEntity, CatalogueTodoWaiterEntity, TodoOption } from './todo-entities'

export const TODO_WAITPOINT_PREFIX = '__catalogue_todo__/'
export class TodoError extends Error {
    constructor(message: string, public statusCode: number) {
        super(message)
    }
}
export type TodoCreate = { title: string, description: string, statusOptions: TodoOption[], flowId: string, runId?: string, assigneeId?: string, resolveUrl: string }

export const todoService = (log: FastifyBaseLogger) => ({
    async recoverDeliveries() {
        const waiting = await databaseConnection().getRepository(CatalogueTodoWaiterEntity).createQueryBuilder('waiter')
            .innerJoin('catalogue_todo', 'task', 'task.id = waiter."todoId"')
            .where('waiter."deliveredAt" IS NULL AND task."resolvedAt" IS NOT NULL')
            .orderBy('waiter.updated', 'ASC').take(100).getMany()
        for (const waiter of waiting) {
            try {
                await deliver(await find(waiter.todoId), log, waiter.id)
            }
            catch (error) {
                log.warn({ todoId: waiter.todoId, waiterId: waiter.id, error }, '[todos] Deferred decision delivery; the next sweep will retry')
            }
            finally {
                await databaseConnection().getRepository(CatalogueTodoWaiterEntity).update({ id: waiter.id }, { updated: new Date().toISOString() })
            }
        }
    },
    async create(principal: Principal, body: TodoCreate) {
        assertEnginePrincipal(principal)
        const projectId = principal.projectId
        const dispatch = await assertLiveEngine(principal, [WorkerJobType.EXECUTE_FLOW, WorkerJobType.EXECUTE_ACTION], log)
        if (!body.runId && dispatch?.payload?.jobType === WorkerJobType.EXECUTE_FLOW && dispatch.payload.stepNameToTest) body = { ...body, runId: dispatch.payload.runId }
        const flow = await databaseConnection().getRepository(FlowEntity).findOneBy({ id: body.flowId, projectId })
        if (!flow) throw new TodoError('The workflow is not available in this workspace.', 403)
        if (body.runId) await assertRun(principal, body.runId, body.flowId, dispatch)
        if (body.assigneeId) await assertAssignee({ id: body.assigneeId, principal, projectId, log })
        const key = await createKey({ body, principal, dispatch })
        const requestHash = hash(JSON.stringify({ title: body.title, description: body.description, statusOptions: body.statusOptions, flowId: body.flowId, runId: body.runId ?? null, assigneeId: body.assigneeId ?? null }))
        const row = await databaseConnection().transaction(async manager => {
            // The project lock serializes idempotent creation, including different engine retries.
            await manager.getRepository(ProjectEntity).findOneOrFail({ where: { id: projectId }, lock: { mode: 'pessimistic_write' } })
            const existing = await manager.getRepository(CatalogueTodoEntity).findOneBy({ projectId, requestKey: key })
            if (existing) {
                if (existing.requestHash !== requestHash) throw new TodoError('This task creation was already used with different details.', 409)
                return existing
            }
            return manager.getRepository(CatalogueTodoEntity).save({ id: apId(), projectId, platformId: principal.platform.id, flowId: body.flowId, runId: body.runId ?? null, title: body.title, description: body.description, statusOptions: body.statusOptions, status: null, assigneeId: body.assigneeId ?? null, message: null, resolvedBy: null, resolvedAt: null, requestKey: key, requestHash })
        })
        return view(row, false)
    },
    async assignees(principal: Principal) {
        assertEnginePrincipal(principal)
        const projectId = principal.projectId
        await assertLiveEngine(principal, [WorkerJobType.EXECUTE_FLOW, WorkerJobType.EXECUTE_ACTION, WorkerJobType.EXECUTE_PROPERTY], log)
        const users = await databaseConnection().getRepository(UserEntity).findBy({ platformId: principal.platform.id, status: UserStatus.ACTIVE })
        const data: { id: string, firstName: string, lastName: string }[] = []
        for (const user of users) {
            if (!await eligibleAssignee(user.id, principal, projectId, log)) continue
            const identity = await databaseConnection().getRepository(UserIdentityEntity).findOneBy({ id: user.identityId, verified: true })
            if (identity) data.push({ id: user.id, firstName: identity.firstName, lastName: identity.lastName })
        }
        return { data }
    },
    async get(principal: Principal, id: string) {
        const row = await find(id)
        if (principal.type === PrincipalType.ENGINE) {
            if (row.projectId !== engineProject(principal) || row.platformId !== principal.platform.id) throw new TodoError('This task is not available in this workspace.', 403)
            await assertLiveEngine(principal, [WorkerJobType.EXECUTE_FLOW, WorkerJobType.EXECUTE_ACTION], log)
            return view(row, false)
        }
        await authorizeUser(principal, row, log, false)
        return view(row, await mayResolve(principal, row, log))
    },
    async wait(principal: Principal, id: string, body: { flowRunId: string, waitpointId: string }) {
        assertEnginePrincipal(principal)
        const projectId = principal.projectId
        const dispatch = await assertLiveEngine(principal, [WorkerJobType.EXECUTE_FLOW], log)
        await assertRun(principal, body.flowRunId, undefined, dispatch)
        const waitpoint = await databaseConnection().getRepository(WaitpointEntity).findOneBy({ id: body.waitpointId, flowRunId: body.flowRunId, projectId })
        if (!waitpoint || waitpoint.type !== PauseType.WEBHOOK || !waitpoint.stepName.startsWith(TODO_WAITPOINT_PREFIX) || waitpoint.status === WaitpointStatus.CONSUMED || (dispatch && waitpoint.hostingDispatchId !== dispatch.id)) throw new TodoError('This task cannot use the requested waitpoint.', 403)
        const row = await databaseConnection().transaction(async manager => {
            const task = await locked(manager, id)
            if (task.projectId !== projectId || task.platformId !== principal.platform.id) throw new TodoError('This task is not available in this workspace.', 403)
            const existing = await manager.getRepository(CatalogueTodoWaiterEntity).findOneBy({ waitpointId: body.waitpointId })
            if (existing && existing.todoId !== id) throw new TodoError('This waitpoint is already assigned to another task.', 409)
            if (!existing) await manager.getRepository(CatalogueTodoWaiterEntity).insert({ id: apId(), todoId: id, projectId, flowRunId: body.flowRunId, waitpointId: body.waitpointId, deliveredAt: null })
            return task
        })
        await deliver(row, log)
        return view(row, false)
    },
    async resolve(principal: Principal, id: string, decision: { status: string, message?: string }) {
        const peek = await find(id)
        await authorizeUser(principal, peek, log, true)
        const row = await databaseConnection().transaction(async manager => {
            const task = await locked(manager, id)
            const option = task.statusOptions.find(value => value.name === decision.status)
            if (!option) throw new TodoError('Choose one of the task’s available statuses.', 400)
            if (task.resolvedAt) {
                if (task.status?.name !== option.name || (task.message ?? '') !== (decision.message ?? '')) throw new TodoError('This task has already been resolved.', 409)
                return task
            }
            return manager.getRepository(CatalogueTodoEntity).save({ ...task, status: option, message: decision.message ?? '', resolvedBy: principal.id, resolvedAt: option.continueFlow ? new Date() : null })
        })
        // Human decisions never reserve Credits. Persist first, then resume the already-admitted root.
        // Same-decision retries repeat delivery safely after a lost response or queue interruption.
        await deliver(row, log)
        return view(row, await mayResolve(principal, row, log))
    },
})

async function find(id: string): Promise<CatalogueTodo> {
    const row = await databaseConnection().getRepository(CatalogueTodoEntity).findOneBy({ id })
    if (!row) throw new TodoError('This task could not be found.', 404)
    return row
}
async function locked(manager: EntityManager, id: string): Promise<CatalogueTodo> {
    const row = await manager.getRepository(CatalogueTodoEntity).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
    if (!row) throw new TodoError('This task could not be found.', 404)
    return row
}
type EnginePrincipal = Extract<Principal, { type: PrincipalType.ENGINE }>
function assertEnginePrincipal(principal: Principal): asserts principal is EnginePrincipal {
    if (principal.type !== PrincipalType.ENGINE || !principal.projectId) throw new TodoError('A workflow engine is required.', 403)
}
function engineProject(principal: Principal): string {
    assertEnginePrincipal(principal); return principal.projectId
}
async function assertLiveEngine(principal: Principal, types: WorkerJobType[], log: FastifyBaseLogger): Promise<HostingDispatch | undefined> {
    assertEnginePrincipal(principal)
    const projectId = principal.projectId
    await communityAuthorization.assertProjectAccess({ principal, projectId, permission: Permission.WRITE_FLOW, log })
    if (hostingConfiguration.getServiceMode() !== 'hosted') return undefined
    return tx.run({ dataSource: databaseConnection(), fn: async manager => {
        const account = await tx.account({ manager, platformId: principal.platform.id })
        const now = await tx.now(manager)
        const dispatch = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId: principal.id, platformId: principal.platform.id, projectId, state: 'running' })
        if (!dispatch?.payload || !types.includes(dispatch.payload.jobType) || !('projectId' in dispatch.payload) || dispatch.payload.projectId !== projectId || dispatch.payload.platformId !== principal.platform.id || dispatch.completionStatus || dispatch.terminalReceipt || !dispatch.leaseUntil || dispatch.leaseUntil <= now) throw new TodoError('This workflow execution is no longer authorized.', 403)
        await tx.member({ manager, actor: { platformId: dispatch.platformId, identityId: dispatch.identityId, ...(dispatch.originType === 'user' ? { tokenVersion: dispatch.tokenVersion } : {}) }, projectId, write: true })
        tx.assertActive({ account, now })
        return dispatch
    } })
}
async function assertRun(principal: Principal, runId: string, flowId: string | undefined, dispatch?: HostingDispatch) {
    const run = await databaseConnection().getRepository(FlowRunEntity).findOneBy({ id: runId, projectId: engineProject(principal) })
    if (!run || (flowId && run.flowId !== flowId) || (dispatch && dispatch.flowRunId !== runId) || ![FlowRunStatus.RUNNING, FlowRunStatus.QUEUED].includes(run.status)) throw new TodoError('This workflow run is not available.', 403)
    return run
}
async function eligibleAssignee(id: string, principal: Principal, projectId: string, log: FastifyBaseLogger): Promise<boolean> {
    assertEnginePrincipal(principal)
    const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id, platformId: principal.platform.id, status: UserStatus.ACTIVE })
    if (!user) return false
    return (await communityAuthorization.getUserPermissions({ userId: id, platformId: principal.platform.id, projectId, log })).has(Permission.WRITE_FLOW)
}
async function assertAssignee(params: { id: string, principal: Principal, projectId: string, log: FastifyBaseLogger }) {
    if (!await eligibleAssignee(params.id, params.principal, params.projectId, params.log)) throw new TodoError('Choose an active assignee from this workspace.', 400)
}
async function authorizeUser(principal: Principal, task: CatalogueTodo, log: FastifyBaseLogger, write: boolean) {
    if (principal.type !== PrincipalType.USER || principal.platform.id !== task.platformId) throw new TodoError('This task is not available in this workspace.', 403)
    await communityAuthorization.assertProjectAccess({ principal, projectId: task.projectId, permission: write ? Permission.WRITE_FLOW : Permission.READ_FLOW, log })
    if (write && hostingConfiguration.getServiceMode() === 'hosted') await tx.run({ dataSource: databaseConnection(), fn: async manager => {
        const account = await tx.account({ manager, platformId: task.platformId })
        const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: task.platformId })
        if (!user) throw new TodoError('This account is no longer available.', 403)
        await tx.member({ manager, actor: { identityId: user.identityId, platformId: task.platformId, tokenVersion: principal.tokenVersion ?? null }, projectId: task.projectId, write: true })
        tx.assertActive({ account, now: await tx.now(manager) })
    } })
    if (write && !await mayResolve(principal, task, log, true)) throw new TodoError('Only the assignee or workspace administrator can resolve this task.', 403)
}
async function mayResolve(principal: Principal, task: CatalogueTodo, log: FastifyBaseLogger, allowResolved = false) {
    if (principal.type !== PrincipalType.USER || (!allowResolved && task.resolvedAt)) return false
    const permissions = await communityAuthorization.getUserPermissions({ userId: principal.id, platformId: task.platformId, projectId: task.projectId, log })
    if (!permissions.has(Permission.WRITE_FLOW)) return false
    if (!task.assigneeId || task.assigneeId === principal.id) return true
    const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id: principal.id, platformId: task.platformId, status: UserStatus.ACTIVE })
    const project = await databaseConnection().getRepository(ProjectEntity).findOneBy({ id: task.projectId })
    return user?.platformRole === PlatformRole.ADMIN || project?.ownerId === principal.id
}
async function createKey({ body, principal, dispatch }: { body: TodoCreate, principal: Principal, dispatch?: HostingDispatch }) {
    const base = new URL(await domainHelper.getPublicApiUrl({ path: `v1/flow-runs/${body.runId ?? dispatch?.flowRunId ?? ''}/` }))
    let target: URL
    try {
        target = new URL(body.resolveUrl)
    }
    catch {
        throw new TodoError('Invalid task request identity.', 400)
    }
    if (body.runId) {
        const prefix = base.pathname.replace(/\/$/, '') + '/'
        if (target.search || target.hash || target.origin !== base.origin || !target.pathname.startsWith(prefix)) throw new TodoError('The task callback must belong to its workflow run.', 400)
        const suffix = target.pathname.slice(prefix.length)
        if (!/^(waitpoints\/[A-Za-z0-9_-]{21}|requests\/todo-[a-f0-9]{64})$/.test(suffix)) throw new TodoError('This task requires the current catalogue runtime.', 400)
        return `${body.runId}:${hash(suffix)}`
    }
    // Action tests have no runId and cannot authorize a resume. Their engine admission scopes replay.
    if (dispatch?.payload?.jobType !== WorkerJobType.EXECUTE_ACTION && hostingConfiguration.getServiceMode() === 'hosted') throw new TodoError('A task run is required.', 400)
    return `test:${principal.id}:${hash(target.href)}`
}
function hash(value: string) {
    return createHash('sha256').update(value).digest('hex')
}
function view(row: CatalogueTodo, canResolve: boolean) {
    return { id: row.id, projectId: row.projectId, title: row.title, description: row.description, statusOptions: row.statusOptions, status: row.status ?? { name: 'Pending', variant: 'neutral', continueFlow: false }, resolved: !!row.resolvedAt, assigneeId: row.assigneeId, message: row.message, canResolve, created: row.created, updated: row.updated }
}
async function deliver(task: CatalogueTodo, log: FastifyBaseLogger, waiterId?: string) {
    if (!task.resolvedAt || !task.status?.continueFlow) return
    const waiters = await databaseConnection().getRepository(CatalogueTodoWaiterEntity).findBy({ todoId: task.id, projectId: task.projectId, ...(waiterId ? { id: waiterId } : {}) })
    for (const waiter of waiters) {
        if (waiter.deliveredAt) continue
        const run = await databaseConnection().getRepository(FlowRunEntity).findOneBy({ id: waiter.flowRunId, projectId: task.projectId })
        if (!run || ![FlowRunStatus.PAUSED, FlowRunStatus.RUNNING, FlowRunStatus.QUEUED].includes(run.status)) continue
        const result = await resumeService(log).resumeTrusted({ flowRunId: waiter.flowRunId, waitpointId: waiter.waitpointId, resumePayload: { body: {}, headers: {}, queryParams: { status: task.status.name, message: task.message ?? '' } } })
        if (result.stale && !await resumeService(log).waitpointWasConsumed({ flowRunId: waiter.flowRunId, waitpointId: waiter.waitpointId })) continue
        await databaseConnection().getRepository(CatalogueTodoWaiterEntity).update({ id: waiter.id }, { deliveredAt: new Date() })
    }
}
