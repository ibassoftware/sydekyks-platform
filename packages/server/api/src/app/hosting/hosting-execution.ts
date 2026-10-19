import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { AgentRunSource, EngineResponseStatus, ExecutionType, FileType, FlowRunStatus, FlowStatus, isFlowRunStateTerminal, JobData, LATEST_JOB_DATA_SCHEMA_VERSION, ResumeReason, StreamStepProgress, WorkerJobType } from '@activepieces/shared'
import { DataSource, EntityManager, In } from 'typeorm'
import { FileEntity } from '../file/file.entity'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { domainHelper } from '../helper/domain-helper'
import { ProjectEntity } from '../project/project-entity'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { UserEntity } from '../user/user-entity'
import { WaitpointEntity } from '../waitpoints/waitpoint-entity'
import { WaitpointStatus } from '../waitpoints/waitpoint-types'
import { HostingDispatch, HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingReservationEntity } from './hosting-entities'
import { currentHostedFlowPayer, hostedFlowPayer } from './hosting-flow-payer'
import { createHostedLedger } from './hosting-ledger'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const MAX_SEGMENTS = 128
const MAX_DEPTH = 8
const MAX_PAYLOAD_BYTES = 1024 * 1024
const LEASE_MS = 120_000
const ACTIVE: HostingDispatch['state'][] = ['admitted', 'running', 'uncertain']

export function createHostedExecution({ dataSource }: { dataSource: DataSource }) {
    async function prepare({ queueName, jobId, data, origin, delay = 0 }: Delivery & { origin?: HostingJobOrigin, delay?: number }): Promise<JobData> {
        if (!data.platformId || !data.projectId) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
        const platformId = data.platformId
        const projectId = data.projectId
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId })
            const project = await manager.getRepository(ProjectEntity).findOneBy({ id: projectId, platformId })
            if (!project) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
            const queueKey = deliveryKey({ queueName, jobId })
            const existing = await manager.getRepository(HostingDispatchEntity).findOneBy({ queueKey })
            if (existing && origin?.type === 'resume') {
                if (existing.platformId !== platformId || existing.projectId !== projectId || existing.flowRunId !== (data.jobType === WorkerJobType.EXECUTE_FLOW ? data.runId : null) || existing.rootKey !== `resume:${origin.waitpointId}` || !existing.payload) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return existing.payload
            }
            let actor: HostingActor
            let rootKey: string
            let previous: HostingDispatch | null = null
            let flowRunId: string | null = null
            let generation = 0
            if (data.jobType === WorkerJobType.EXECUTE_FLOW) {
                const flow = await manager.getRepository(FlowEntity).findOneBy({ id: data.flowId, projectId })
                const version = await manager.getRepository(FlowVersionEntity).findOne({ where: { id: data.flowVersionId, flowId: data.flowId }, lock: { mode: 'pessimistic_read' } })
                const run = await manager.getRepository(FlowRunEntity).findOneBy({ id: data.runId, projectId, flowId: data.flowId, flowVersionId: data.flowVersionId })
                if (!flow || !version || !run) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
                // Fail unsupported/mixed AI selections before creating a dispatch.
                hostedFlowPayer(version, data.stepNameToTest)
                flowRunId = data.runId
                if (data.executionType === ExecutionType.RESUME) {
                    if (origin?.type !== 'resume' || data.resumeReason !== ResumeReason.WAITPOINT) hostingFail('HOSTING_WAITPOINT_REQUIRED')
                    previous = await manager.getRepository(HostingDispatchEntity).findOne({ where: { platformId, flowRunId }, order: { generation: 'DESC' } })
                    if (!previous || previous.terminalReceipt !== FlowRunStatus.PAUSED || !previous.checkpoint || !['paused', 'running'].includes(previous.state)) hostingFail('HOSTING_CHECKPOINT_REQUIRED')
                    const waitpoint = await manager.getRepository(WaitpointEntity).findOne({ where: { id: origin.waitpointId, flowRunId, projectId }, lock: { mode: 'pessimistic_write' } })
                    if (!waitpoint || waitpoint.status !== WaitpointStatus.COMPLETED || waitpoint.hostingDispatchId !== previous.id || previous.waitpointId !== waitpoint.id) hostingFail('HOSTING_WAITPOINT_REQUIRED')
                    actor = actorOf(previous)
                    generation = previous.generation + 1
                    rootKey = `resume:${waitpoint.id}`
                    data = { ...data, logsFileId: digest(`logs:${queueKey}`).slice(0, 21), resumeCheckpointId: previous.id, payload: { type: 'inline' as const, value: waitpoint.resumePayload }, httpRequestId: waitpoint.httpRequestId ?? waitpoint.id, workerHandlerId: waitpoint.workerHandlerId, environment: previous.payload?.jobType === WorkerJobType.EXECUTE_FLOW ? previous.payload.environment : data.environment }
                    await manager.getRepository(WaitpointEntity).update({ id: waitpoint.id, projectId }, { status: WaitpointStatus.CONSUMED })
                }
                else {
                    if (run.parentRunId) hostingFail('HOSTING_AUTHENTICATED_NESTED_CALL_REQUIRED')
                    if (!origin || origin.type === 'resume') hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                    const userId = origin.type === 'scheduled' ? project.ownerId : origin.userId
                    if ((origin.type === 'scheduled' && run.triggeredBy) || (origin.type === 'user' && (run.triggeredBy !== origin.userId || origin.tokenVersion === undefined))) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                    const user = await manager.getRepository(UserEntity).findOneBy({ id: userId, platformId })
                    if (!user) hostingFail('HOSTING_ACCESS_DENIED')
                    actor = { platformId, identityId: user.identityId, ...(origin.type === 'user' ? { tokenVersion: origin.tokenVersion } : {}) }
                    rootKey = `flow:${data.runId}`
                }
            }
            else if (data.jobType === WorkerJobType.EXECUTE_AGENT_RUN && data.source === AgentRunSource.CHAT && !data.flowRunId && !data.waitpointId) {
                if (!data.runId || origin?.type !== 'user' || origin.userId !== data.userId || origin.tokenVersion === undefined) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                const user = await manager.getRepository(UserEntity).findOneBy({ id: data.userId, platformId })
                if (!user) hostingFail('HOSTING_ACCESS_DENIED')
                actor = { platformId, identityId: user.identityId, tokenVersion: origin.tokenVersion }
                rootKey = `agent:${data.conversationId}:${data.runId}`
            }
            else hostingFail('HOSTING_JOB_PATH_NOT_READY')
            await assertLiveContext({ manager, data })
            await tx.member({ manager, actor, projectId, write: true })
            tx.assertActive({ account, now: await tx.now(manager) })
            if (existing) {
                if (existing.platformId !== platformId || existing.payloadHash !== hashData(data) || existing.identityId !== actor.identityId || existing.tokenVersion !== (actor.tokenVersion ?? null)) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                if (!['prepared', 'admitted'].includes(existing.state)) hostingFail('HOSTING_REPLAY_DENIED')
                return data
            }
            const id = apId()
            const root = previous ? await rootOf({ manager, dispatch: previous }) : null
            if (root) await assertBound({ manager, root })
            const normalized = JobData.parse(JSON.parse(JSON.stringify(data)))
            assertPayload(normalized)
            if (!Number.isSafeInteger(delay) || delay < 0 || delay > 86_400_000) hostingFail('HOSTING_INVALID_DELAY')
            await manager.getRepository(HostingDispatchEntity).save({ id, platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion ?? null, originType: actor.tokenVersion === undefined ? 'scheduled' : 'user', queueKey, payloadHash: hashData(normalized), rootKey, state: 'prepared', flowRunId, generation, rootDispatchId: root?.id ?? null, parentDispatchId: previous?.id ?? null, callbackWaitpointId: previous?.callbackWaitpointId ?? null, queueName, jobId, payload: normalized, availableAt: new Date((await tx.now(manager)).getTime() + delay) })
            return normalized
        } })
    }

    async function nested({ admissionId, projectId, platformId, flowId, key, payload, failParentOnFailure, queueName }: NestedParams) {
        tx.assertKey(key)
        assertPayload(payload)
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId })
            const parent = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId, platformId, projectId })
            if (!parent?.flowRunId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            const root = await rootOf({ manager, dispatch: parent })
            const rootKey = `nested:${digest(JSON.stringify([parent.flowRunId, key]))}`
            const requestHash = hashData({ flowId, payload, failParentOnFailure })
            const existing = await manager.getRepository(HostingDispatchEntity).findOneBy({ platformId, rootKey })
            if (existing) {
                if (existing.requestHash !== requestHash || existing.projectId !== projectId) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return { runId: required(existing.flowRunId), dispatchId: existing.id }
            }
            if (parent.state !== 'running' || parent.terminalReceipt || !parent.leaseUntil || parent.leaseUntil <= await tx.now(manager)) hostingFail('HOSTING_PARENT_NOT_RUNNING')
            await tx.member({ manager, actor: actorOf(parent), projectId, write: true })
            tx.assertActive({ account, now: await tx.now(manager) })
            await assertBound({ manager, root })
            let callbackWaitpointId: string | null = null
            if (payload && typeof payload === 'object' && 'callbackUrl' in payload && payload.callbackUrl !== undefined) {
                if (typeof payload.callbackUrl !== 'string') hostingFail('HOSTING_CALLBACK_SCOPE_MISMATCH')
                const url = new URL(payload.callbackUrl)
                const waitpointId = url.pathname.split('/').at(-1)
                const expected = await domainHelper.getPublicApiUrl({ path: `v1/flow-runs/${parent.flowRunId}/waitpoints/${waitpointId}` })
                if (payload.callbackUrl !== expected || !waitpointId || !await manager.getRepository(WaitpointEntity).existsBy({ id: waitpointId, flowRunId: parent.flowRunId, projectId, hostingDispatchId: parent.id })) hostingFail('HOSTING_CALLBACK_SCOPE_MISMATCH')
                callbackWaitpointId = waitpointId
            }
            if (failParentOnFailure && !callbackWaitpointId) hostingFail('HOSTING_CALLBACK_SCOPE_MISMATCH')
            let ancestor: HostingDispatch | null = parent
            const ancestorRuns = new Set<string>()
            while (ancestor) {
                ancestorRuns.add(required(ancestor.flowRunId))
                if (ancestorRuns.size >= MAX_DEPTH) hostingFail('HOSTING_NESTING_LIMIT')
                ancestor = ancestor.parentDispatchId ? await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: ancestor.parentDispatchId, platformId }) : null
            }
            const flow = await manager.getRepository(FlowEntity).findOneBy({ id: flowId, projectId, status: FlowStatus.ENABLED })
            if (!flow?.publishedVersionId) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
            const version = await manager.getRepository(FlowVersionEntity).findOneByOrFail({ id: flow.publishedVersionId, flowId })
            if (!('pieceName' in version.trigger.settings) || version.trigger.settings.pieceName !== '@activepieces/piece-subflows') hostingFail('HOSTING_CALLABLE_FLOW_REQUIRED')
            const parentRun = await manager.getRepository(FlowRunEntity).findOneByOrFail({ id: parent.flowRunId, projectId })
            const runId = apId()
            const id = apId()
            const data = JobData.parse({ schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_FLOW, projectId, platformId, flowId, flowVersionId: version.id, runId, executionType: ExecutionType.BEGIN, executeTrigger: true, payload: { type: 'inline', value: { body: payload, headers: {}, queryParams: {}, method: 'POST' } }, logsFileId: apId(), environment: parentRun.environment, streamStepProgress: StreamStepProgress.NONE })
            assertPayload(data)
            await manager.getRepository(FlowRunEntity).insert({ id: runId, projectId, flowId, flowVersionId: version.id, environment: parentRun.environment, parentRunId: parent.flowRunId, failParentOnFailure, triggeredBy: parentRun.triggeredBy, status: FlowRunStatus.QUEUED, tags: [] })
            await manager.getRepository(HostingDispatchEntity).save({ id, platformId, projectId, identityId: parent.identityId, tokenVersion: parent.tokenVersion, originType: parent.originType, queueKey: deliveryKey({ queueName, jobId: runId }), payloadHash: hashData(data), rootKey, state: 'prepared', flowRunId: runId, rootDispatchId: root.id, parentDispatchId: parent.id, generation: 0, queueName, jobId: runId, payload: data, availableAt: await tx.now(manager), requestHash, callbackWaitpointId })
            return { runId, dispatchId: id }
        } })
    }

    async function admit({ queueName, jobId, data, queueToken }: Delivery & { queueToken: string }): Promise<string> {
        const outcome = await tx.run({ dataSource, fn: async manager => {
            const peek = await binding({ manager, queueName, jobId })
            const account = await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (!['prepared', 'admitted'].includes(dispatch.state)) {
                if (dispatch.state === 'running') await uncertain({ manager, dispatch })
                return { denial: 'HOSTING_REPLAY_DENIED' }
            }
            try {
                assertData({ dispatch, data })
                await assertLiveContext({ manager, data })
                await tx.member({ manager, actor: actorOf(dispatch), projectId: dispatch.projectId, write: true })
                tx.assertActive({ account, now: await tx.now(manager) })
                const root = await rootOf({ manager, dispatch })
                const siblings = await tree({ manager, root })
                if (siblings.some(item => item.id !== dispatch.id && ACTIVE.includes(item.state))) hostingFail('HOSTING_CONCURRENCY_LIMIT')
                if (dispatch.parentDispatchId) {
                    const parent = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: dispatch.parentDispatchId, platformId: dispatch.platformId })
                    if (!['completed', 'paused'].includes(parent.state)) hostingFail('HOSTING_CONCURRENCY_LIMIT')
                }
                const ledger = createHostedLedger({ dataSource, manager })
                const reservation = root.reservationId
                    ? await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: root.reservationId, platformId: root.platformId })
                    : await ledger.reserveExecution({ actor: actorOf(root), projectId: root.projectId, key: root.rootKey, payer: root.payload?.jobType === WorkerJobType.EXECUTE_FLOW ? await currentHostedFlowPayer({ manager, flowId: root.payload.flowId, flowVersionId: root.payload.flowVersionId, projectId: root.projectId, stepNameToTest: root.payload.stepNameToTest }) : 'managed' })
                if (root.reservationId === null) await manager.getRepository(HostingDispatchEntity).update({ id: root.id }, { reservationId: reservation.id })
                if (reservation.state !== 'reserved') await ledger.resumeExecution({ actor: actorOf(dispatch), reservationId: reservation.id })
                const admissionId = apId()
                await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'admitted', reservationId: reservation.id, admissionId, queueTokenHash: digest(queueToken), connectionId: null, leaseUntil: lease(await tx.now(manager)) })
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
            if (dispatch.state !== 'admitted' || dispatch.admissionId !== admissionId || dispatch.queueTokenHash !== digest(queueToken) || !dispatch.leaseUntil || dispatch.leaseUntil <= await tx.now(manager)) return false
            try {
                assertData({ dispatch, data })
                await assertLiveContext({ manager, data })
                const ledger = createHostedLedger({ dataSource, manager })
                const reservation = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: required(dispatch.reservationId), platformId: dispatch.platformId })
                const claim = reservation.state === 'reserved'
                    ? await ledger.claimExecution({ actor: actorOf(dispatch), reservationId: reservation.id })
                    : (await ledger.resumeExecution({ actor: actorOf(dispatch), reservationId: reservation.id }), { claimed: true, dispatchId: reservation.dispatchId })
                await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: claim.claimed ? 'running' : 'cancelled', dispatchId: claim.dispatchId, connectionId, leaseUntil: lease(await tx.now(manager)) })
                if (!claim.claimed) await cancelUnsentDispatch({ manager, dispatch, reason: 'HOSTING_ENTITLEMENT_EXPIRED' })
                if (claim.claimed && dispatch.flowRunId) await manager.getRepository(FlowRunEntity).update({ id: dispatch.flowRunId, projectId: dispatch.projectId }, { status: FlowRunStatus.RUNNING, startTime: new Date().toISOString(), finishTime: null })
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
            if (!['running', 'uncertain', 'completed', 'paused'].includes(dispatch.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            dispatch.completionStatus = status
            await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { completionStatus: status })
            if (status === EngineResponseStatus.INTERNAL_ERROR) await uncertain({ manager, dispatch })
            else await finalize({ manager, dispatch })
        } })
    }

    async function flowReceipt({ admissionId, connectionId, projectId, runId, status, checkpoint, logsFileId, waitpointId }: Receipt): Promise<void> {
        if (checkpoint) assertPayload(checkpoint)
        await tx.run({ dataSource, fn: async manager => {
            if (!admissionId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            const peek = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId })
            if (!peek || peek.projectId !== projectId || peek.flowRunId !== runId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: peek.id })
            if ((admissionId && dispatch.admissionId !== admissionId) || (connectionId && dispatch.connectionId !== connectionId)) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            const latest = await manager.getRepository(HostingDispatchEntity).findOne({ where: { platformId: dispatch.platformId, flowRunId: runId }, order: { generation: 'DESC' } })
            if (latest?.id !== dispatch.id) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            if (!['running', 'uncertain', 'completed', 'paused'].includes(dispatch.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            if (dispatch.resolutionStatus) return
            if (!status || status === FlowRunStatus.RUNNING || status === FlowRunStatus.QUEUED) return
            if (dispatch.terminalReceipt && dispatch.terminalReceipt !== status) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
            if (status === FlowRunStatus.PAUSED) {
                if (!checkpoint || !checkpoint.executionState || !dispatch.payload || dispatch.payload.jobType !== WorkerJobType.EXECUTE_FLOW || logsFileId !== dispatch.payload.logsFileId || !waitpointId) hostingFail('HOSTING_CHECKPOINT_REQUIRED')
                const file = await manager.getRepository(FileEntity).findOneBy({ id: dispatch.payload.logsFileId, projectId, platformId: dispatch.platformId, type: FileType.FLOW_RUN_LOG })
                if (!file || (dispatch.checkpoint && hashData(dispatch.checkpoint) !== hashData(checkpoint))) hostingFail('HOSTING_CHECKPOINT_REQUIRED')
                if (!await manager.getRepository(WaitpointEntity).existsBy({ id: waitpointId, flowRunId: runId, projectId, hostingDispatchId: dispatch.id })) hostingFail('HOSTING_WAITPOINT_REQUIRED')
                dispatch.checkpoint = checkpoint
                dispatch.waitpointId = waitpointId
            }
            dispatch.terminalReceipt = status
            await manager.getRepository(HostingDispatchEntity).save(dispatch)
            await manager.getRepository(FlowRunEntity).update({ id: runId, projectId }, { status, finishTime: status === FlowRunStatus.PAUSED ? null : new Date().toISOString(), logsFileId: dispatch.payload?.jobType === WorkerJobType.EXECUTE_FLOW ? dispatch.payload.logsFileId : undefined })
            if (status === FlowRunStatus.INTERNAL_ERROR) await uncertain({ manager, dispatch })
            else await finalize({ manager, dispatch })
        } })
    }

    async function checkpoint({ admissionId, checkpointId, projectId, platformId }: { admissionId: string, checkpointId: string, projectId: string, platformId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId })
            const current = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId, projectId, platformId, state: 'running' })
            if (!current || current.parentDispatchId !== checkpointId || current.payload?.jobType !== WorkerJobType.EXECUTE_FLOW || current.payload.executionType !== ExecutionType.RESUME || current.payload.resumeCheckpointId !== checkpointId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            const previous = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: checkpointId, platformId, projectId, flowRunId: required(current.flowRunId) })
            if (!previous.checkpoint) hostingFail('HOSTING_CHECKPOINT_REQUIRED')
            return previous.checkpoint
        } })
    }

    async function assertEngineRun({ admissionId, platformId, projectId, runId }: { admissionId: string, platformId: string, projectId: string, runId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId })
            const dispatch = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId, platformId, projectId, flowRunId: runId, state: 'running' })
            if (!dispatch || !dispatch.leaseUntil || dispatch.leaseUntil <= await tx.now(manager)) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            return dispatch
        } })
    }

    async function heartbeat({ queueName, jobId, admissionId, queueToken, connectionId }: { queueName: string, jobId: string, admissionId: string, queueToken: string, connectionId: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            const peek = await binding({ manager, queueName, jobId })
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (dispatch.admissionId !== admissionId || dispatch.queueTokenHash !== digest(queueToken) || dispatch.connectionId !== connectionId || dispatch.state !== 'running' || !dispatch.leaseUntil || dispatch.leaseUntil <= await tx.now(manager)) return
            await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { leaseUntil: lease(await tx.now(manager)) })
        } })
    }

    async function disconnect({ queueName, jobId, admissionId }: { queueName: string, jobId: string, admissionId: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            const peek = await binding({ manager, queueName, jobId })
            await tx.account({ manager, platformId: peek.platformId })
            const dispatch = await binding({ manager, queueName, jobId })
            if (dispatch.admissionId !== admissionId) return
            if (dispatch.state === 'running') await uncertain({ manager, dispatch })
            else if (dispatch.state === 'admitted') await resetUnsent({ manager, dispatch })
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
            if (['completed', 'cancelled', 'paused'].includes(dispatch.state)) return
            if (['running', 'uncertain'].includes(dispatch.state)) {
                await uncertain({ manager, dispatch }); return
            }
            await cancelUnsentDispatch({ manager, dispatch, reason: 'cancelled' })
        } })
    }

    async function uncertain({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }): Promise<void> {
        if (['completed', 'paused', 'uncertain'].includes(dispatch.state)) return
        const reservation = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: required(dispatch.reservationId), platformId: dispatch.platformId })
        if (reservation.state === 'running') await createHostedLedger({ dataSource, manager }).markUncertain({ platformId: dispatch.platformId, reservationId: reservation.id, dispatchId: required(dispatch.dispatchId), attemptKey: dispatch.id })
        await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'uncertain' })
    }

    async function cancelUnsentDispatch({ manager, dispatch, reason }: { manager: EntityManager, dispatch: HostingDispatch, reason: string }): Promise<void> {
        const root = await rootOf({ manager, dispatch })
        if (dispatch.id === root.id && root.reservationId) {
            const reservation = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: root.reservationId, platformId: root.platformId })
            if (reservation.state === 'reserved') await createHostedLedger({ dataSource, manager }).cancelUnsent({ platformId: root.platformId, reservationId: reservation.id })
        }
        await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'cancelled' })
        if (dispatch.flowRunId) await manager.getRepository(FlowRunEntity).update({ id: dispatch.flowRunId, projectId: dispatch.projectId }, { status: FlowRunStatus.FAILED, finishTime: new Date().toISOString() })
        await signalParentFailure({ manager, dispatch, status: FlowRunStatus.FAILED })
        await tx.event({ manager, platformId: dispatch.platformId, event: 'execution.denied', payload: { dispatchId: dispatch.id, reason } })
        await reconcileRoot({ manager, root })
    }

    async function finalize({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }): Promise<void> {
        if (['completed', 'paused'].includes(dispatch.state) || !dispatch.completionStatus || dispatch.completionStatus === EngineResponseStatus.INTERNAL_ERROR) return
        if (dispatch.flowRunId && !dispatch.terminalReceipt) return
        if (dispatch.terminalReceipt === FlowRunStatus.INTERNAL_ERROR) return
        const paused = dispatch.terminalReceipt === FlowRunStatus.PAUSED
        if (dispatch.flowRunId && !paused && !isFlowRunStateTerminal({ status: dispatch.terminalReceipt ?? FlowRunStatus.RUNNING, ignoreInternalError: true })) return
        await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: paused ? 'paused' : 'completed', leaseUntil: null })
        if (!paused && dispatch.terminalReceipt) await signalParentFailure({ manager, dispatch, status: dispatch.terminalReceipt })
        await reconcileRoot({ manager, root: await rootOf({ manager, dispatch }) })
    }

    async function signalParentFailure({ manager, dispatch, status }: { manager: EntityManager, dispatch: HostingDispatch, status: FlowRunStatus }): Promise<void> {
        if (!dispatch.callbackWaitpointId || !dispatch.flowRunId || status === FlowRunStatus.SUCCEEDED) return
        const run = await manager.getRepository(FlowRunEntity).findOneByOrFail({ id: dispatch.flowRunId, projectId: dispatch.projectId })
        if (!run.failParentOnFailure || !run.parentRunId) return
        const waitpoint = await manager.getRepository(WaitpointEntity).findOne({ where: { id: dispatch.callbackWaitpointId, flowRunId: run.parentRunId, projectId: dispatch.projectId }, lock: { mode: 'pessimistic_write' } })
        if (!waitpoint || waitpoint.status !== WaitpointStatus.PENDING) return
        await manager.getRepository(WaitpointEntity).save({ ...waitpoint, status: WaitpointStatus.COMPLETED, resumePayload: { body: { status: 'error', data: { message: 'Subflow execution failed', status, runId: run.id } }, headers: {}, queryParams: {} } })
        await tx.event({ manager, platformId: dispatch.platformId, event: 'execution.child_failed', payload: { dispatchId: dispatch.id, waitpointId: waitpoint.id } })
    }

    async function expireWaitpoint({ platformId, projectId, runId, waitpointId }: { platformId: string, projectId: string, runId: string, waitpointId: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId })
            const waitpoint = await manager.getRepository(WaitpointEntity).findOne({ where: { id: waitpointId, flowRunId: runId, projectId }, lock: { mode: 'pessimistic_write' } })
            if (!waitpoint?.hostingDispatchId || waitpoint.status !== WaitpointStatus.PENDING || !waitpoint.resumeDateTime || new Date(waitpoint.resumeDateTime) > await tx.now(manager)) return
            const latest = await manager.getRepository(HostingDispatchEntity).findOne({ where: { platformId, projectId, flowRunId: runId }, order: { generation: 'DESC' } })
            if (!latest || latest.id !== waitpoint.hostingDispatchId || latest.waitpointId !== waitpoint.id || latest.state !== 'paused') return
            await manager.getRepository(WaitpointEntity).update({ id: waitpoint.id }, { status: WaitpointStatus.CONSUMED })
            await manager.getRepository(HostingDispatchEntity).update({ id: latest.id }, { state: 'completed', resolutionStatus: FlowRunStatus.FAILED })
            await manager.getRepository(FlowRunEntity).update({ id: runId, projectId }, { status: FlowRunStatus.FAILED, finishTime: new Date().toISOString() })
            await signalParentFailure({ manager, dispatch: latest, status: FlowRunStatus.FAILED })
            await tx.event({ manager, platformId, event: 'execution.waitpoint_expired', payload: { dispatchId: latest.id, waitpointId } })
            await reconcileRoot({ manager, root: await rootOf({ manager, dispatch: latest }) })
        } })
    }

    async function reconcileRoot({ manager, root }: { manager: EntityManager, root: HostingDispatch }): Promise<void> {
        const fresh = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: root.id })
        if (!fresh.reservationId) return
        const reservation = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: fresh.reservationId, platformId: fresh.platformId })
        if (['reserved', 'settled', 'released'].includes(reservation.state)) return
        const segments = await tree({ manager, root: fresh })
        if (segments.some(item => ACTIVE.includes(item.state))) return
        if (await manager.getRepository(HostingReservationEntity).existsBy({ platformId: fresh.platformId, rootReservationId: reservation.id, state: In(['reserved', 'running', 'uncertain']) })) return
        if (await manager.getRepository(HostingModelCallEntity).existsBy({ platformId: fresh.platformId, rootReservationId: reservation.id, state: In(['prepared', 'running', 'uncertain']) })) return
        const latestByRun = new Map<string, HostingDispatch>()
        for (const item of segments) {
            const key = item.flowRunId ?? item.id
            if (!latestByRun.has(key) || (latestByRun.get(key)?.generation ?? -1) < item.generation) latestByRun.set(key, item)
        }
        const ledger = createHostedLedger({ dataSource, manager })
        const fence = { platformId: fresh.platformId, reservationId: reservation.id, dispatchId: required(reservation.dispatchId) }
        if ([...latestByRun.values()].every(item => ['completed', 'cancelled'].includes(item.state))) await ledger.finishExecution(fence)
        else await ledger.parkExecution(fence)
    }

    async function reconcile({ platformId, dispatchId }: { platformId: string, dispatchId: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId })
            const dispatch = await manager.getRepository(HostingDispatchEntity).findOneBy({ id: dispatchId, platformId })
            if (!dispatch) hostingFail('HOSTING_INVALID_TRANSITION')
            if (['running', 'uncertain'].includes(dispatch.state)) await finalize({ manager, dispatch })
            await reconcileRoot({ manager, root: await rootOf({ manager, dispatch }) })
        } })
    }

    async function recover({ publish, limit = 50 }: { publish: (dispatch: HostingDispatch) => Promise<void>, limit?: number }) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) hostingFail('HOSTING_INVALID_RECOVERY_LIMIT')
        const candidates = await dataSource.getRepository(HostingDispatchEntity).createQueryBuilder('d')
            .leftJoin('hosting_reservation', 'r', 'r.id = d."reservationId" AND r."platformId" = d."platformId"')
            .where('(d.state = \'prepared\' AND d."availableAt" <= clock_timestamp()) OR (d.state IN (\'admitted\', \'running\') AND d."leaseUntil" <= clock_timestamp()) OR (d.state = \'uncertain\' AND d."completionStatus" IS NOT NULL AND d."completionStatus" <> :internal) OR (d.state IN (\'completed\', \'paused\') AND d."rootDispatchId" IS NULL AND r.state IN (\'running\', \'paused\', \'uncertain\'))', { internal: EngineResponseStatus.INTERNAL_ERROR })
            .orderBy('d.updated', 'ASC').addOrderBy('d.id', 'ASC').take(limit).getMany()
        for (const candidate of candidates) {
            const ready = await tx.run({ dataSource, fn: async manager => {
                await tx.account({ manager, platformId: candidate.platformId })
                let dispatch = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: candidate.id })
                const now = await tx.now(manager)
                if (dispatch.state === 'running' && dispatch.leaseUntil && dispatch.leaseUntil <= now) await uncertain({ manager, dispatch })
                if (dispatch.state === 'admitted' && dispatch.leaseUntil && dispatch.leaseUntil <= now) await resetUnsent({ manager, dispatch })
                dispatch = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: dispatch.id })
                if (['running', 'uncertain'].includes(dispatch.state)) await finalize({ manager, dispatch })
                await reconcileRoot({ manager, root: await rootOf({ manager, dispatch }) })
                await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { updated: now })
                return dispatch.state === 'prepared' && dispatch.payload && dispatch.availableAt && dispatch.availableAt <= now ? dispatch : null
            } })
            if (!ready) continue
            await publish(ready)
            await dataSource.getRepository(HostingDispatchEntity).update({ id: ready.id, state: 'prepared' }, { publishedAt: new Date() })
        }
    }

    return { prepare, nested, admit, start, complete, disconnect, cancel, flowReceipt, checkpoint, assertEngineRun, heartbeat, reconcile, recover, expireWaitpoint }
}

async function rootOf({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }): Promise<HostingDispatch> {
    return dispatch.rootDispatchId ? manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: dispatch.rootDispatchId, platformId: dispatch.platformId, projectId: dispatch.projectId }) : dispatch
}
async function tree({ manager, root }: { manager: EntityManager, root: HostingDispatch }): Promise<HostingDispatch[]> {
    return manager.getRepository(HostingDispatchEntity).find({ where: [{ id: root.id, platformId: root.platformId }, { rootDispatchId: root.id, platformId: root.platformId }] })
}
async function assertBound({ manager, root }: { manager: EntityManager, root: HostingDispatch }) {
    if ((await tree({ manager, root })).length >= MAX_SEGMENTS) hostingFail('HOSTING_SEGMENT_LIMIT')
}
async function resetUnsent({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }) {
    await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'prepared', admissionId: null, queueTokenHash: null, connectionId: null, leaseUntil: null })
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
function lease(now: Date): Date {
    return new Date(now.getTime() + LEASE_MS)
}
function required(value: string | null): string {
    if (!value) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH'); return value
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
function hashData(data: unknown): string {
    return digest(canonical(JSON.parse(JSON.stringify(data))))
}
function assertPayload(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_PAYLOAD_BYTES) hostingFail('HOSTING_PAYLOAD_LIMIT')
}
type Delivery = { queueName: string, jobId: string, data: JobData }
type Completion = { queueName: string, jobId: string, queueToken: string, connectionId: string, admissionId: string, status: EngineResponseStatus }
type Receipt = { admissionId?: string, connectionId?: string, projectId: string, runId: string, status?: FlowRunStatus, checkpoint?: Record<string, unknown>, logsFileId?: string, waitpointId?: string }
type NestedParams = { admissionId: string, projectId: string, platformId: string, flowId: string, key: string, payload: unknown, failParentOnFailure: boolean, queueName: string }
export type HostingJobOrigin = { type: 'user', userId: string, tokenVersion?: string | null } | { type: 'scheduled' } | { type: 'resume', waitpointId: string }
