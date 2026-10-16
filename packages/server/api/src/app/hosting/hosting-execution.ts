import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { AgentRunSource, EngineResponseStatus, ExecutionType, FlowRunStatus, isFlowRunStateTerminal, JobData, WorkerJobType } from '@activepieces/shared'
import { DataSource, EntityManager, In } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { ProjectEntity } from '../project/project-entity'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { UserEntity } from '../user/user-entity'
import { HostingDispatch, HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingReservationEntity } from './hosting-entities'
import { createHostedLedger } from './hosting-ledger'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export function createHostedExecution({ dataSource }: { dataSource: DataSource }) {
    async function prepare({ queueName, jobId, data, origin }: Delivery & { origin?: HostingJobOrigin }): Promise<void> {
        if (!data.platformId || !data.projectId) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
        const platformId = data.platformId
        const projectId = data.projectId
        await tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId })
            const project = await manager.getRepository(ProjectEntity).findOneBy({ id: projectId, platformId })
            if (!project) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
            let userId: string
            let rootKey: string
            let flowRunId: string | null = null
            if (data.jobType === WorkerJobType.EXECUTE_FLOW) {
                if (data.executionType !== ExecutionType.BEGIN) hostingFail('HOSTING_SEGMENT_COORDINATOR_REQUIRED')
                if (!origin) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                userId = origin.type === 'scheduled' ? project.ownerId : origin.userId
                const flow = await manager.getRepository(FlowEntity).findOneBy({ id: data.flowId, projectId })
                const version = await manager.getRepository(FlowVersionEntity).findOneBy({ id: data.flowVersionId, flowId: data.flowId })
                const run = await manager.getRepository(FlowRunEntity).findOneBy({ id: data.runId, projectId, flowId: data.flowId, flowVersionId: data.flowVersionId })
                if (!flow || !version || !run) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
                if (run.parentRunId) hostingFail('HOSTING_NESTED_COORDINATOR_REQUIRED')
                if (origin.type === 'scheduled' && run.triggeredBy) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                if (origin.type === 'user' && run.triggeredBy !== origin.userId) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                flowRunId = data.runId
                rootKey = `flow:${data.runId}`
            }
            else if (data.jobType === WorkerJobType.EXECUTE_AGENT_RUN && data.source === AgentRunSource.CHAT && !data.flowRunId && !data.waitpointId) {
                userId = data.userId
                if (!data.runId || origin?.type !== 'user' || origin.userId !== data.userId) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                rootKey = `agent:${data.conversationId}:${data.runId}`
            }
            else hostingFail('HOSTING_JOB_PATH_NOT_READY')
            tx.assertKey(rootKey)
            if (!origin || (origin.type === 'user' && origin.tokenVersion === undefined)) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
            await assertLiveContext({ manager, data })
            const user = await manager.getRepository(UserEntity).findOneBy({ id: userId, platformId })
            if (!user) hostingFail('HOSTING_ACCESS_DENIED')
            const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: user.identityId })
            const actor = { platformId, identityId: user.identityId, ...(origin.type === 'user' ? { tokenVersion: origin.tokenVersion } : {}) }
            if (!identity.verified) hostingFail('HOSTING_ACCESS_DENIED')
            await tx.member({ manager, actor, projectId, write: true })
            tx.assertActive({ account, now: await tx.now(manager) })
            const queueKey = deliveryKey({ queueName, jobId })
            const payloadHash = hashData(data)
            const existing = await manager.getRepository(HostingDispatchEntity).findOneBy({ queueKey })
            if (existing) {
                if (existing.platformId !== platformId || existing.payloadHash !== payloadHash || existing.identityId !== actor.identityId || existing.originType !== origin.type || (origin.type === 'user' && existing.tokenVersion !== origin.tokenVersion)) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                if (existing.state !== 'prepared' && existing.state !== 'admitted') hostingFail('HOSTING_REPLAY_DENIED')
                return
            }
            if (await manager.getRepository(HostingDispatchEntity).existsBy({ platformId, rootKey })) hostingFail('HOSTING_SEGMENT_COORDINATOR_REQUIRED')
            await manager.getRepository(HostingDispatchEntity).insert({ id: apId(), platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion ?? null, originType: origin.type, queueKey, payloadHash, rootKey, state: 'prepared', flowRunId })
        } })
    }

    async function admit({ queueName, jobId, data, queueToken }: Delivery & { queueToken: string }): Promise<string> {
        const outcome = await tx.run({ dataSource, fn: async manager => {
            const peek = await binding({ manager, queueName, jobId })
            const account = await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (dispatch.state !== 'prepared' && dispatch.state !== 'admitted') {
                if (dispatch.state === 'running') await uncertain({ manager, dispatch })
                return { denial: 'HOSTING_REPLAY_DENIED' }
            }
            try {
                assertData({ dispatch, data })
                await assertLiveContext({ manager, data })
                tx.assertActive({ account, now: await tx.now(manager) })
                const ledger = createHostedLedger({ dataSource, manager })
                const reservation = await ledger.reserveExecution({ actor: actorOf(dispatch), projectId: dispatch.projectId, key: dispatch.rootKey, payer: 'managed' })
                if (reservation.state !== 'reserved') hostingFail('HOSTING_REPLAY_DENIED')
                const admissionId = apId()
                await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'admitted', reservationId: reservation.id, admissionId, queueTokenHash: digest(queueToken), connectionId: null })
                return { admissionId }
            }
            catch (error) {
                if (!(error instanceof HostingError) || error.message === 'HOSTING_CONCURRENCY_LIMIT') throw error
                await cancelUnsentDispatch({ manager, dispatch, reason: error.message })
                return { denial: error.message }
            }
        } })
        if (outcome.denial) hostingFail(outcome.denial)
        return required(outcome.admissionId ?? null)
    }

    async function start({ queueName, jobId, data, queueToken, connectionId, admissionId }: Delivery & { queueToken: string, connectionId: string, admissionId: string }): Promise<boolean> {
        return tx.run({ dataSource, fn: async manager => {
            const peek = await binding({ manager, queueName, jobId })
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (dispatch.state !== 'admitted' || dispatch.admissionId !== admissionId || dispatch.queueTokenHash !== digest(queueToken)) return false
            try {
                assertData({ dispatch, data })
                await assertLiveContext({ manager, data })
                const claim = await createHostedLedger({ dataSource, manager }).claimExecution({ actor: actorOf(dispatch), reservationId: required(dispatch.reservationId) })
                await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: claim.claimed ? 'running' : 'cancelled', dispatchId: claim.dispatchId, connectionId })
                return claim.claimed
            }
            catch (error) {
                if (!(error instanceof HostingError)) throw error
                await cancelUnsentDispatch({ manager, dispatch, reason: error.message })
                return false
            }
        } })
    }

    async function complete({ queueName, jobId, queueToken, connectionId, admissionId, status }: Completion): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            const peek = await binding({ manager, queueName, jobId })
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (dispatch.admissionId !== admissionId || dispatch.queueTokenHash !== digest(queueToken) || dispatch.connectionId !== connectionId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            if (dispatch.completionStatus && dispatch.completionStatus !== status) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
            if (!['running', 'uncertain', 'completed'].includes(dispatch.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            dispatch.completionStatus = status
            await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { completionStatus: status })
            if (status === EngineResponseStatus.INTERNAL_ERROR) await uncertain({ manager, dispatch })
            else await finalize({ manager, dispatch })
        } })
    }

    async function flowReceipt({ admissionId, connectionId, projectId, runId, status }: { admissionId?: string, connectionId?: string, projectId: string, runId: string, status?: FlowRunStatus }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            const peek = admissionId
                ? await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId })
                : connectionId ? await manager.getRepository(HostingDispatchEntity).findOneBy({ connectionId, projectId, flowRunId: runId }) : null
            if (!peek || peek.projectId !== projectId || peek.flowRunId !== runId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: peek.id })
            if ((admissionId && dispatch.admissionId !== admissionId) || (connectionId && dispatch.connectionId !== connectionId)) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            if (!['running', 'uncertain', 'completed'].includes(dispatch.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            if (!status || status === FlowRunStatus.RUNNING || status === FlowRunStatus.QUEUED) return
            if (dispatch.terminalReceipt && dispatch.terminalReceipt !== status) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
            dispatch.terminalReceipt = status
            await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { terminalReceipt: status })
            if (status === FlowRunStatus.INTERNAL_ERROR || status === FlowRunStatus.PAUSED) await uncertain({ manager, dispatch })
            else await finalize({ manager, dispatch })
        } })
    }

    async function disconnect({ queueName, jobId, admissionId }: { queueName: string, jobId: string, admissionId: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            const peek = await binding({ manager, queueName, jobId })
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (dispatch.admissionId !== admissionId) return
            if (dispatch.state === 'running') await uncertain({ manager, dispatch })
            else if (dispatch.state === 'admitted') await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'prepared', admissionId: null, queueTokenHash: null, connectionId: null })
        } })
    }

    async function cancel({ queueName, jobId, allowMissing = false }: { queueName: string, jobId: string, allowMissing?: boolean }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            const peek = await manager.getRepository(HostingDispatchEntity).findOneBy({ queueKey: deliveryKey({ queueName, jobId }) })
            if (!peek) {
                if (allowMissing) return; hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
            }
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (dispatch.state === 'completed' || dispatch.state === 'cancelled') return
            if (dispatch.state === 'running' || dispatch.state === 'uncertain') {
                await uncertain({ manager, dispatch }); return
            }
            if (dispatch.reservationId) await createHostedLedger({ dataSource, manager }).cancelUnsent({ platformId: dispatch.platformId, reservationId: dispatch.reservationId })
            await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'cancelled' })
        } })
    }

    async function uncertain({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }): Promise<void> {
        if (dispatch.state === 'completed' || dispatch.state === 'uncertain') return
        await createHostedLedger({ dataSource, manager }).markUncertain({ platformId: dispatch.platformId, reservationId: required(dispatch.reservationId), dispatchId: required(dispatch.dispatchId) })
        await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'uncertain' })
    }

    async function cancelUnsentDispatch({ manager, dispatch, reason }: { manager: EntityManager, dispatch: HostingDispatch, reason: string }): Promise<void> {
        if (dispatch.reservationId) await createHostedLedger({ dataSource, manager }).cancelUnsent({ platformId: dispatch.platformId, reservationId: dispatch.reservationId })
        await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'cancelled' })
        await tx.event({ manager, platformId: dispatch.platformId, event: 'execution.denied', payload: { dispatchId: dispatch.id, reason } })
    }

    async function finalize({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }): Promise<void> {
        if (dispatch.state === 'completed' || !dispatch.completionStatus || dispatch.completionStatus === EngineResponseStatus.INTERNAL_ERROR) return
        if (dispatch.flowRunId && (!dispatch.terminalReceipt || !isFlowRunStateTerminal({ status: dispatch.terminalReceipt, ignoreInternalError: true }))) return
        const reservation = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: required(dispatch.reservationId), platformId: dispatch.platformId })
        if (await manager.getRepository(HostingReservationEntity).existsBy({ platformId: dispatch.platformId, rootReservationId: reservation.id, state: In(['reserved', 'running', 'uncertain']) })) return
        await createHostedLedger({ dataSource, manager }).finishExecution({ platformId: dispatch.platformId, reservationId: reservation.id, dispatchId: required(dispatch.dispatchId) })
        await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'completed' })
    }

    async function reconcile({ platformId, dispatchId }: { platformId: string, dispatchId: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId })
            const dispatch = await manager.getRepository(HostingDispatchEntity).findOneBy({ id: dispatchId, platformId })
            if (!dispatch || !['running', 'uncertain', 'completed'].includes(dispatch.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            await finalize({ manager, dispatch })
        } })
    }

    return { prepare, admit, start, complete, disconnect, cancel, flowReceipt, reconcile }
}

async function assertLiveContext({ manager, data }: { manager: EntityManager, data: JobData }): Promise<void> {
    if (data.jobType === WorkerJobType.EXECUTE_AGENT_RUN) {
        const conversation = await manager.getRepository(SydConversationEntity).findOneBy({ id: data.conversationId, platformId: data.platformId, userId: data.userId, source: AgentRunSource.CHAT, activeRunId: data.runId })
        if (!conversation || (conversation.projectId && conversation.projectId !== data.projectId)) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
    }
}

async function binding({ manager, queueName, jobId }: { manager: EntityManager, queueName: string, jobId: string }): Promise<HostingDispatch> {
    const value = await manager.getRepository(HostingDispatchEntity).findOneBy({ queueKey: deliveryKey({ queueName, jobId }) })
    if (!value) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
    return value
}
function actorOf(dispatch: HostingDispatch): HostingActor {
    return { identityId: dispatch.identityId, platformId: dispatch.platformId, ...(dispatch.originType === 'user' ? { tokenVersion: dispatch.tokenVersion } : {}) }
}
function assertData({ dispatch, data }: { dispatch: HostingDispatch, data: JobData }): void {
    if (dispatch.payloadHash !== hashData(data) || dispatch.platformId !== data.platformId || dispatch.projectId !== data.projectId) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
}
function deliveryKey({ queueName, jobId }: { queueName: string, jobId: string }): string {
    return digest(JSON.stringify([queueName, jobId]))
}
function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}
function required(value: string | null): string {
    if (!value) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH'); return value
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
function hashData(data: JobData): string {
    return digest(canonical(JSON.parse(JSON.stringify(data))))
}
type Delivery = { queueName: string, jobId: string, data: JobData }
type Completion = { queueName: string, jobId: string, queueToken: string, connectionId: string, admissionId: string, status: EngineResponseStatus }
export type HostingJobOrigin = { type: 'user', userId: string, tokenVersion?: string | null } | { type: 'scheduled' }
