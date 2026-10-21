import { apId } from '@activepieces/core-utils'
import { EngineResponseStatus, ExecutionType, FileType, FlowActionType, FlowRunStatus, FlowTrigger, FlowTriggerType, FlowVersionState, JobData, LATEST_FLOW_SCHEMA_VERSION, LATEST_JOB_DATA_SCHEMA_VERSION, PackageType, PauseType, PieceType, Principal, PrincipalType, RunEnvironment, StreamStepProgress, WorkerJobType } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { resume } = vi.hoisted(() => ({ resume: vi.fn() }))
vi.mock('../../src/app/waitpoints/resume-service', () => ({ resumeService: () => ({ resumeTrusted: resume, waitpointWasConsumed: async () => false }) }))
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { FileEntity } from '../../src/app/file/file.entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { FlowEntity } from '../../src/app/flows/flow/flow.entity'
import { FlowRunEntity } from '../../src/app/flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../../src/app/flows/flow-version/flow-version-entity'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { createHostedExecution } from '../../src/app/hosting/hosting-execution'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { todoController } from '../../src/app/todos/todo-controller'
import { CatalogueTodoEntity, CatalogueTodoWaiterEntity } from '../../src/app/todos/todo-entities'
import { todoService } from '../../src/app/todos/todo-service'
import { WaitpointEntity } from '../../src/app/waitpoints/waitpoint-entity'
import { WaitpointStatus } from '../../src/app/waitpoints/waitpoint-types'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, app: FastifyInstance, previousConnection: unknown, principal: Principal
let value: { platformId: string, projectId: string, userId: string, identityId: string, tokenVersion: string | null, admissionId: string, taskId: string, queueToken: string, connectionId: string, propertyJobId: string }
const statuses = [{ name: 'Reviewing', variant: 'neutral', continueFlow: false }, { name: 'Accepted', variant: 'positive', continueFlow: true }, { name: 'Rejected', variant: 'negative', continueFlow: true }]
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    vi.stubEnv('AP_FRONTEND_URL', 'http://127.0.0.1:3289')
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 403).send({ message: error.message }))
    app.addHook('preHandler', async request => {
        request.principal = principal
    })
    app.addHook('preHandler', authorizationMiddleware)
    await app.register(todoController, { prefix: '/todos' }); await app.ready()
})
afterAll(async () => {
    if (app) await app.close(); Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection); if (ds?.isInitialized) await ds.destroy(); vi.unstubAllEnvs()
})
beforeEach(async () => {
    resume.mockReset().mockResolvedValue({ stale: false })
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@example.com`.toLowerCase(), provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Todo', lastName: 'Owner' })
    const tenant = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-todo-secret-at-least-32-characters' }), identityId)
    if (!tenant.projectId) throw new Error('Expected tenant project')
    const id = apId(), data = JobData.parse({ schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_PROPERTY, platformId: tenant.platformId, projectId: tenant.projectId, requestId: id, webserverId: 'synthetic-todos', actionOrTriggerName: 'createTodo', propertyName: 'assigneeId', input: {}, sampleData: {}, piece: { pieceName: '@activepieces/piece-todos', pieceVersion: '0.0.17', pieceType: PieceType.OFFICIAL, packageType: PackageType.REGISTRY } })
    const delivery = { queueName: 'todo-tests', jobId: id, data }, execution = createHostedExecution({ dataSource: ds }), queueToken = apId()
    await execution.prepare({ ...delivery, origin: { type: 'user', userId: tenant.userId, tokenVersion: tenant.tokenVersion } })
    const admissionId = await execution.admit({ ...delivery, queueToken })
    const connectionId = apId()
    expect(await execution.start({ ...delivery, queueToken, admissionId, connectionId })).toBe(true)
    const taskId = apId()
    value = { ...tenant, projectId: tenant.projectId, identityId, admissionId, taskId, queueToken, connectionId, propertyJobId: id }
    await ds.getRepository(CatalogueTodoEntity).insert({ id: taskId, platformId: tenant.platformId, projectId: tenant.projectId, flowId: apId(), runId: null, title: 'Review estimate', description: 'Test task', statusOptions: statuses, status: null, assigneeId: null, message: null, resolvedBy: null, resolvedAt: null, requestKey: apId(), requestHash: 'a'.repeat(64) })
    principal = { type: PrincipalType.USER, id: tenant.userId, platform: { id: tenant.platformId }, tokenVersion: tenant.tokenVersion ?? undefined }
})
function engine() {
    principal = { type: PrincipalType.ENGINE, id: value.admissionId, platform: { id: value.platformId }, projectId: value.projectId }
}
function resolveTask(status = 'Accepted', message = '') {
    return app.inject({ method: 'POST', url: `/todos/${value.taskId}/resolve`, payload: { status, message } })
}

async function flowFixture(stepTest = false) {
    const execution = createHostedExecution({ dataSource: ds })
    await execution.complete({ queueName: 'todo-tests', jobId: value.propertyJobId, queueToken: value.queueToken, admissionId: value.admissionId, connectionId: value.connectionId, status: EngineResponseStatus.OK })
    const flowId = apId(), versionId = apId(), runId = apId(), logsFileId = apId()
    await ds.getRepository(FlowEntity).insert({ id: flowId, projectId: value.projectId, externalId: apId() })
    const trigger = { name: 'trigger', type: FlowTriggerType.PIECE, displayName: 'Run manually', valid: true, settings: { pieceName: '@activepieces/piece-manual-trigger', pieceVersion: '0.0.8', triggerName: 'manual_trigger', input: {}, propertySettings: {} }, nextAction: { name: 'task', type: FlowActionType.PIECE, settings: { pieceName: '@activepieces/piece-todos', actionName: 'createTodoAndWait', input: {} } } } as unknown as FlowTrigger
    await ds.getRepository(FlowVersionEntity).insert({ id: versionId, flowId, displayName: 'Todo fixture', schemaVersion: LATEST_FLOW_SCHEMA_VERSION, trigger, connectionIds: [], agentIds: [], valid: true, state: FlowVersionState.LOCKED, notes: [] })
    await ds.getRepository(FileEntity).insert({ id: logsFileId, platformId: value.platformId, projectId: value.projectId, type: FileType.FLOW_RUN_LOG, location: 'DB', data: Buffer.from('{}') })
    await ds.getRepository(FlowRunEntity).insert({ id: runId, flowId, flowVersionId: versionId, projectId: value.projectId, environment: RunEnvironment.TESTING, status: FlowRunStatus.QUEUED, tags: [], triggeredBy: value.userId })
    const data = JobData.parse({ schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_FLOW, platformId: value.platformId, projectId: value.projectId, flowId, flowVersionId: versionId, runId, logsFileId, environment: RunEnvironment.TESTING, executionType: ExecutionType.BEGIN, streamStepProgress: StreamStepProgress.NONE, payload: { type: 'inline', value: {} }, ...(stepTest ? { stepNameToTest: 'task' } : {}) })
    const delivery = { queueName: 'todo-flow-tests', jobId: runId, data }, queueToken = apId()
    await execution.prepare({ ...delivery, origin: { type: 'user', userId: value.userId, tokenVersion: value.tokenVersion } })
    const admissionId = await execution.admit({ ...delivery, queueToken }), connectionId = apId()
    expect(await execution.start({ ...delivery, queueToken, admissionId, connectionId })).toBe(true)
    await ds.getRepository(FlowRunEntity).update({ id: runId }, { status: FlowRunStatus.RUNNING })
    const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId })
    const waitpointId = apId()
    await ds.getRepository(WaitpointEntity).insert({ id: waitpointId, flowRunId: runId, projectId: value.projectId, hostingDispatchId: dispatch.id, type: PauseType.WEBHOOK, version: 'V1', status: WaitpointStatus.PENDING, stepName: '__catalogue_todo__/task' })
    principal = { type: PrincipalType.ENGINE, id: admissionId, platform: { id: value.platformId }, projectId: value.projectId }
    return { flowId, runId, waitpointId }
}
function owner() {
    principal = { type: PrincipalType.USER, id: value.userId, platform: { id: value.platformId }, tokenVersion: value.tokenVersion ?? undefined }
}
function bind(fixture: { runId: string, waitpointId: string }) {
    return app.inject({ method: 'POST', url: `/todos/${value.taskId}/wait`, payload: { flowRunId: fixture.runId, waitpointId: fixture.waitpointId } })
}

describe('catalogue Todos authenticated decisions and durable delivery', () => {
    it('reads task details without exposing callback authority', async () => {
        const response = await app.inject({ method: 'GET', url: `/todos/${value.taskId}` })
        expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ title: 'Review estimate', resolved: false, canResolve: true })
        expect(response.body).not.toMatch(/requestHash|requestKey|resumeUrl|resolveUrl|token/)
    })
    it('keeps legacy GET scanner-safe and only redirects to authenticated UI', async () => {
        const response = await app.inject({ method: 'GET', url: `/todos/${value.taskId}/resolve?status=Accepted&isTest=false` })
        expect(response.statusCode).toBe(303); expect(response.headers.location).toBe(`http://127.0.0.1:3289/todos/${value.taskId}/resolve?status=Accepted`)
        expect((await ds.getRepository(CatalogueTodoEntity).findOneByOrFail({ id: value.taskId })).resolvedAt).toBeNull(); expect(resume).not.toHaveBeenCalled()
    })
    it('persists nonterminal updates without resuming, then finalizes once without new Credit reservation', async () => {
        const before = await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })
        expect((await resolveTask('Reviewing', 'Checking details')).json()).toMatchObject({ status: { name: 'Reviewing' }, resolved: false })
        expect(resume).not.toHaveBeenCalled()
        expect((await resolveTask('Accepted', 'Approved')).json()).toMatchObject({ resolved: true, message: 'Approved', canResolve: false })
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(before)
    })
    it('makes repeated identical decisions idempotent and rejects conflicting replay', async () => {
        expect((await resolveTask()).statusCode).toBe(200)
        expect((await resolveTask()).statusCode).toBe(200)
        expect((await resolveTask('Rejected')).statusCode).toBe(409)
    })
    it('rejects an unconfigured status and excessive decision messages', async () => {
        expect((await resolveTask('Unexpected')).statusCode).toBe(400)
        expect((await resolveTask('Accepted', 'x'.repeat(4001))).statusCode).toBe(400)
        expect((await ds.getRepository(CatalogueTodoEntity).findOneByOrFail({ id: value.taskId })).resolvedAt).toBeNull()
    })
    it('rejects foreign tenant task access and resolution', async () => {
        principal = { ...principal, platform: { id: apId() } } as Principal
        expect((await app.inject({ method: 'GET', url: `/todos/${value.taskId}` })).statusCode).toBe(403)
        expect((await resolveTask()).statusCode).toBe(403)
    })
    it('does not accept an ENGINE as a human resolver', async () => {
        engine(); expect((await resolveTask()).statusCode).toBe(403); expect(resume).not.toHaveBeenCalled()
    })
    it('assignee options require a live admitted PROPERTY job and create no additional reservation', async () => {
        engine(); const before = await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })
        const response = await app.inject({ method: 'GET', url: '/todos/assignees' })
        expect(response.statusCode).toBe(200); expect(response.json().data).toContainEqual({ id: value.userId, firstName: 'Todo', lastName: 'Owner' })
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(before)
    })
    it.each(['expired', 'completed', 'revoked-session', 'wrong-job'])('rejects %s ENGINE provenance', async change => {
        engine(); const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: value.admissionId })
        if (change === 'expired') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { leaseUntil: new Date(Date.now() - 1000) })
        if (change === 'completed') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { completionStatus: EngineResponseStatus.OK })
        if (change === 'revoked-session') await ds.getRepository(UserIdentityEntity).update({ id: value.identityId }, { tokenVersion: apId() })
        if (change === 'wrong-job') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { payload: { ...dispatch.payload, jobType: WorkerJobType.EXECUTE_VALIDATION } as JobData })
        expect((await app.inject({ method: 'GET', url: '/todos/assignees' })).statusCode).toBe(403)
    })
    it('does not allow PROPERTY maintenance to create a task or bind a wait', async () => {
        engine()
        expect((await app.inject({ method: 'POST', url: '/todos', payload: { title: 'Denied', statusOptions: statuses, flowId: apId(), resolveUrl: 'http://127.0.0.1:3289/api/v1/flow-runs/test/requests/test' } })).statusCode).toBe(403)
        expect((await app.inject({ method: 'POST', url: `/todos/${value.taskId}/wait`, payload: { flowRunId: apId(), waitpointId: apId() } })).statusCode).toBe(403)
    })
    it.each([false, true])('creates and deduplicates a valid current flow task (builder step test=%s)', async stepTest => {
        const fixture = await flowFixture(stepTest)
        const payload = { title: 'Created in flow', statusOptions: statuses, flowId: fixture.flowId, ...(stepTest ? {} : { runId: fixture.runId }), resolveUrl: `http://127.0.0.1:3289/api/v1/flow-runs/${fixture.runId}/waitpoints/${fixture.waitpointId}` }
        const first = await app.inject({ method: 'POST', url: '/todos', payload })
        expect(first.statusCode).toBe(201)
        const replay = await app.inject({ method: 'POST', url: '/todos', payload })
        expect(replay.json().id).toBe(first.json().id)
        expect((await app.inject({ method: 'POST', url: '/todos', payload: { ...payload, title: 'Changed' } })).statusCode).toBe(409)
        expect((await app.inject({ method: 'POST', url: '/todos', payload: { ...payload, resolveUrl: 'https://evil.example/api/v1/flow-runs/other/waitpoints/other' } })).statusCode).toBe(400)
    })
    it('binds before resolution, preserves failed delivery, and recovers it exactly once', async () => {
        const fixture = await flowFixture()
        expect((await bind(fixture)).statusCode).toBe(200)
        const count = await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })
        owner(); resume.mockRejectedValueOnce(new Error('Synthetic queue interruption'))
        expect((await resolveTask()).statusCode).toBe(403) // Harness maps unexpected service failure to 403; durable decision is still saved.
        const waiter = await ds.getRepository(CatalogueTodoWaiterEntity).findOneByOrFail({ todoId: value.taskId })
        expect(waiter.deliveredAt).toBeNull()
        expect((await ds.getRepository(CatalogueTodoEntity).findOneByOrFail({ id: value.taskId })).resolvedAt).not.toBeNull()
        await todoService(app.log).recoverDeliveries()
        expect(resume).toHaveBeenCalledTimes(2)
        expect(resume).toHaveBeenLastCalledWith(expect.objectContaining({ flowRunId: fixture.runId, waitpointId: fixture.waitpointId, resumePayload: expect.objectContaining({ queryParams: { status: 'Accepted', message: '' } }) }))
        expect((await ds.getRepository(CatalogueTodoWaiterEntity).findOneByOrFail({ id: waiter.id })).deliveredAt).not.toBeNull()
        await todoService(app.log).recoverDeliveries(); expect(resume).toHaveBeenCalledTimes(2)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(count)
    })
    it('precompletes a task resolved before registration, and refuses cross-run waitpoint bindings', async () => {
        expect((await resolveTask()).statusCode).toBe(200)
        const fixture = await flowFixture()
        expect((await bind({ ...fixture, runId: apId() })).statusCode).toBe(403)
        expect((await bind(fixture)).statusCode).toBe(200)
        expect(resume).toHaveBeenCalledTimes(1)
        expect((await bind(fixture)).statusCode).toBe(200); expect(resume).toHaveBeenCalledTimes(1)
    })
    it('refuses a suspended client’s human decision while preserving task state', async () => {
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { status: 'suspended' })
        expect((await resolveTask()).statusCode).toBe(403)
        expect((await ds.getRepository(CatalogueTodoEntity).findOneByOrFail({ id: value.taskId })).resolvedAt).toBeNull()
        expect(resume).not.toHaveBeenCalled()
    })
    it('keeps an undelivered resolved task durable for the recovery sweep', async () => {
        const task = await ds.getRepository(CatalogueTodoEntity).findOneByOrFail({ id: value.taskId })
        await ds.getRepository(CatalogueTodoEntity).save({ ...task, status: statuses[1], resolvedAt: new Date() })
        const waiterId = apId()
        await ds.getRepository(CatalogueTodoWaiterEntity).insert({ id: waiterId, todoId: value.taskId, projectId: value.projectId, flowRunId: apId(), waitpointId: apId(), deliveredAt: null })
        await todoService(app.log).recoverDeliveries()
        expect((await ds.getRepository(CatalogueTodoWaiterEntity).findOneByOrFail({ id: waiterId })).deliveredAt).toBeNull()
        expect(resume).not.toHaveBeenCalled() // Absent run can never be resumed by a stale persisted binding.
    })
})
