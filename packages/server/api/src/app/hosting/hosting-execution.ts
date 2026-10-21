import { createHash } from 'node:crypto'
import { AIProviderName, apId } from '@activepieces/core-utils'
import { AgentConversationStatus, AgentRunSource, EngineResponseStatus, ExecutionType, FileType, FlowRun, FlowRunStatus, FlowStatus, FlowVersion, isFlowRunStateTerminal, JobData, LATEST_JOB_DATA_SCHEMA_VERSION, ResumeReason, RunEnvironment, StreamStepProgress, TriggerHookType, WorkerJobType } from '@activepieces/shared'
import { ArrayContains, DataSource, EntityManager, In } from 'typeorm'
import { AppConnectionEntity } from '../app-connection/app-connection.entity'
import { FileEntity } from '../file/file.entity'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { domainHelper } from '../helper/domain-helper'
import { encryptUtils } from '../helper/encryption'
import { ProjectEntity } from '../project/project-entity'
import { SydAgentConversationEntity } from '../syd/copilot/models/agent-conversation.entity'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { TriggerSourceEntity } from '../trigger/trigger-source/trigger-source-entity'
import { UserEntity } from '../user/user-entity'
import { WaitpointEntity } from '../waitpoints/waitpoint-entity'
import { WaitpointStatus } from '../waitpoints/waitpoint-types'
import { hostedAiCredential } from './hosting-ai-credentials'
import { HOSTED_DEEPSEEK_MODEL } from './hosting-ai-policy'
import { HostingDispatch, HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingReservationEntity } from './hosting-entities'
import { currentHostedActionPayer, currentHostedFlowPayer, hostedFlowPayer } from './hosting-flow-payer'
import { hasDefinitiveHostedCompletion, HOSTED_COORDINATOR_JOB_TYPES, isHostedMaintenanceJob, isHostedTestTrigger } from './hosting-job-policy'
import { createHostedLedger } from './hosting-ledger'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const MAX_SEGMENTS = 128
const MAX_DEPTH = 8
const MAX_PAYLOAD_BYTES = 1024 * 1024
const LEASE_MS = 120_000
const ACTIVE: HostingDispatch['state'][] = ['admitted', 'running', 'uncertain']

// This result is thrown only AFTER the transaction has committed a definitive,
// undispatched refusal. Unknown transaction/queue outcomes must never use it.
export class HostedRunStartRefused extends Error {
    constructor(readonly flowRun: FlowRun) {
        super('HOSTING_ENTITLEMENT_EXPIRED')
    }
}

export function createHostedExecution({ dataSource }: { dataSource: DataSource }) {
    async function prepare({ queueName, jobId, data, origin, delay = 0 }: Delivery & { origin?: HostingJobOrigin, delay?: number }): Promise<JobData> {
        if (!data.platformId || !data.projectId) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
        const platformId = data.platformId
        const projectId = data.projectId
        const prepared = await tx.run<JobData | HostedRunStartRefused>({ dataSource, fn: async manager => {
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
            let freshRun: FlowRun | undefined
            if (data.jobType === WorkerJobType.EXECUTE_FLOW) {
                const flow = await manager.getRepository(FlowEntity).findOneBy({ id: data.flowId, projectId })
                const version = await manager.getRepository(FlowVersionEntity).findOne({ where: { id: data.flowVersionId, flowId: data.flowId }, lock: { mode: 'pessimistic_read' } })
                const run = await manager.getRepository(FlowRunEntity).findOneBy({ id: data.runId, projectId, flowId: data.flowId, flowVersionId: data.flowVersionId })
                if (!flow || !version || !run) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
                if (!existing && data.executionType === ExecutionType.BEGIN && run.status !== FlowRunStatus.QUEUED) hostingFail('HOSTING_REPLAY_DENIED')
                if (!existing && origin?.type === 'user' && data.executionType === ExecutionType.BEGIN && !run.parentRunId && run.status === FlowRunStatus.QUEUED) freshRun = run
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
                    if (!origin || (origin.type !== 'user' && origin.type !== 'scheduled')) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                    const userId = origin.type === 'scheduled' ? project.ownerId : origin.userId
                    if ((origin.type === 'scheduled' && run.triggeredBy) || (origin.type === 'user' && (run.triggeredBy !== origin.userId || origin.tokenVersion === undefined))) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                    const user = await manager.getRepository(UserEntity).findOneBy({ id: userId, platformId })
                    if (!user) hostingFail('HOSTING_ACCESS_DENIED')
                    actor = { platformId, identityId: user.identityId, ...(origin.type === 'user' ? { tokenVersion: origin.tokenVersion } : {}) }
                    rootKey = `flow:${data.runId}`
                }
            }
            else if (data.jobType === WorkerJobType.EXECUTE_AGENT_RUN && data.source !== undefined && [AgentRunSource.CHAT, AgentRunSource.AGENT, AgentRunSource.AGENT_BUILDER].includes(data.source) && !data.flowRunId && !data.waitpointId) {
                if (!data.runId || origin?.type !== 'user' || origin.userId !== data.userId || origin.tokenVersion === undefined) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                const user = await manager.getRepository(UserEntity).findOneBy({ id: data.userId, platformId })
                if (!user) hostingFail('HOSTING_ACCESS_DENIED')
                actor = { platformId, identityId: user.identityId, tokenVersion: origin.tokenVersion }
                rootKey = `agent:${data.conversationId}:${data.runId}`
            }
            else if (data.jobType === WorkerJobType.EXECUTE_AGENT_RUN && data.source === AgentRunSource.FLOW_STEP) {
                if (origin?.type !== 'agent-step' || !data.runId || !data.flowRunId || data.waitpointId !== origin.waitpointId) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                const parent = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId: origin.admissionId, platformId, projectId, flowRunId: data.flowRunId })
                const point = await manager.getRepository(WaitpointEntity).findOneBy({ id: origin.waitpointId, projectId, flowRunId: data.flowRunId, status: WaitpointStatus.PENDING })
                const now = await tx.now(manager)
                if (!parent || !point || point.hostingDispatchId !== parent.id || parent.payload?.jobType !== WorkerJobType.EXECUTE_FLOW || !['running', 'paused'].includes(parent.state) || (parent.state === 'running' && (!parent.leaseUntil || parent.leaseUntil <= now))) hostingFail('HOSTING_WAITPOINT_REQUIRED')
                actor = actorOf(parent)
                previous = parent
                await assertBound({ manager, root: await rootOf({ manager, dispatch: parent }) })
                rootKey = `agent-step:${origin.waitpointId}`
            }
            else if ((data.jobType === WorkerJobType.EXECUTE_ACTION || isHostedMaintenanceJob(data) || isHostedTestTrigger(data)) && (origin?.type === 'user' || origin?.type === 'operator-maintenance' || origin?.type === 'connection-refresh')) {
                if (origin.type === 'connection-refresh') {
                    if (data.jobType !== WorkerJobType.EXECUTE_TOKEN_REFRESH || (!origin.userId && !origin.parentAdmissionId)) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                    data = { ...data, hostingConnectionId: origin.connectionId, hostingConnectionRevision: origin.credentialRevision }
                    if (origin.parentAdmissionId) {
                        const parent = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId: origin.parentAdmissionId, platformId, projectId, state: 'running' })
                        if (!parent?.payload || parent.payload.jobType === WorkerJobType.EXECUTE_TOKEN_REFRESH || !parent.leaseUntil || parent.leaseUntil <= await tx.now(manager) || parent.terminalReceipt) hostingFail('HOSTING_PARENT_NOT_RUNNING')
                        await assertLiveContext({ manager, data: parent.payload })
                        previous = parent
                    }
                    const user = await manager.getRepository(UserEntity).findOneBy({ id: origin.userId ?? project.ownerId, platformId })
                    if (!user || (origin.userId && origin.tokenVersion === undefined)) hostingFail('HOSTING_ACCESS_DENIED')
                    actor = previous ? actorOf(previous) : { platformId, identityId: user.identityId, ...(origin.userId ? { tokenVersion: origin.tokenVersion } : {}) }
                }
                else {
                    if (origin.tokenVersion === undefined || (data.jobType === WorkerJobType.EXECUTE_TOKEN_REFRESH) || (data.jobType === WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION) !== (origin.type === 'operator-maintenance')) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                    const user = await manager.getRepository(UserEntity).findOneBy({ id: origin.userId, platformId })
                    if (!user) hostingFail('HOSTING_ACCESS_DENIED')
                    actor = { platformId, identityId: user.identityId, tokenVersion: origin.tokenVersion }
                    if (origin.type === 'operator-maintenance') await tx.member({ manager, actor, projectId, write: true, admin: true })
                }
                if (data.jobType === WorkerJobType.EXECUTE_ACTION) await currentHostedActionPayer({ manager, platformId, projectId, step: data.step })
                rootKey = `request:${queueKey}`
            }
            else if (data.jobType === WorkerJobType.EXECUTE_ACTION || data.jobType === WorkerJobType.EXECUTE_PROPERTY) {
                if (origin?.type !== 'agent-tool') hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                tx.assertKey(origin.key)
                const parent = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId: origin.admissionId, platformId, projectId, state: 'running' })
                if (!parent || parent.payload?.jobType !== WorkerJobType.EXECUTE_AGENT_RUN || !parent.leaseUntil || parent.leaseUntil <= await tx.now(manager) || parent.terminalReceipt) hostingFail('HOSTING_PARENT_NOT_RUNNING')
                await assertLiveContext({ manager, data: parent.payload })
                actor = actorOf(parent)
                previous = parent
                rootKey = `tool:${digest(JSON.stringify([parent.id, origin.key]))}`
                if (data.jobType === WorkerJobType.EXECUTE_ACTION) await currentHostedActionPayer({ manager, platformId, projectId, step: data.step })
            }
            else if (isHostedTriggerJob(data)) {
                if (isHostedTestTrigger(data) || (origin?.type !== 'scheduled' && origin?.type !== 'trigger-lifecycle')) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
                if (origin.type === 'trigger-lifecycle') {
                    const parent = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId: origin.admissionId, platformId, projectId, state: 'running' })
                    if (data.jobType !== WorkerJobType.EXECUTE_TRIGGER_HOOK || !parent?.payload || !isHostedTriggerJob(parent.payload) || parent.payload.flowId !== data.flowId || hostedTriggerVersionId(parent.payload) !== data.flowVersionId || !parent.leaseUntil || parent.leaseUntil <= await tx.now(manager)) hostingFail('HOSTING_PARENT_NOT_RUNNING')
                    if (data.hookType === TriggerHookType.HANDSHAKE) {
                        const enabling = parent.payload.jobType === WorkerJobType.EXECUTE_TRIGGER_HOOK && parent.payload.hookType === TriggerHookType.ON_ENABLE && parent.payload.test === data.test
                        const renewing = parent.payload.jobType === WorkerJobType.RENEW_WEBHOOK && !data.test
                        if (!enabling && !renewing) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
                    }
                    else if (!(data.hookType === TriggerHookType.ON_DISABLE && parent.payload.jobType === WorkerJobType.EXECUTE_WEBHOOK && parent.payload.saveSampleData && !parent.payload.execute && data.test)) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
                    previous = parent
                }
                await assertHostedTriggerContext({ manager, data })
                const user = await manager.getRepository(UserEntity).findOneBy({ id: project.ownerId, platformId })
                if (!user) hostingFail('HOSTING_ACCESS_DENIED')
                actor = previous ? actorOf(previous) : { platformId, identityId: user.identityId }
                rootKey = `trigger:${queueKey}`
            }
            else hostingFail('HOSTING_JOB_PATH_NOT_READY')
            if (!existing && (isHostedMaintenanceJob(data) || isHostedTestTrigger(data))) {
                const recent = await manager.getRepository(HostingDispatchEntity).createQueryBuilder('dispatch').where('dispatch."platformId" = :platformId AND dispatch."projectId" = :projectId AND dispatch."identityId" = :identityId AND dispatch.created > clock_timestamp() - interval \'1 minute\'', { platformId, projectId, identityId: actor.identityId }).getCount()
                if (recent >= 60) hostingFail('HOSTING_MAINTENANCE_RATE_LIMIT')
            }
            await assertLiveContext({ manager, data })
            await tx.member({ manager, actor, projectId, write: true })
            if (freshRun && await manager.getRepository(HostingDispatchEntity).existsBy({ platformId, flowRunId: freshRun.id })) freshRun = undefined
            const now = await tx.now(manager)
            try {
                tx.assertActive({ account, now })
            }
            catch (error) {
                if (!(error instanceof HostingError) || error.message !== 'HOSTING_ENTITLEMENT_EXPIRED' || !freshRun) throw error
                const refused: FlowRun = {
                    ...freshRun,
                    status: FlowRunStatus.FAILED,
                    finishTime: now.toISOString(),
                    steps: {},
                    failedStep: {
                        name: 'trigger',
                        displayName: 'Run access',
                        message: 'Workspace access has expired. Contact your administrator or Sydekyks to renew access before running this Mission.',
                    },
                }
                const updated = await manager.getRepository(FlowRunEntity).createQueryBuilder().update().set({ status: refused.status, finishTime: refused.finishTime, failedStep: refused.failedStep }).where({ id: refused.id, projectId, status: FlowRunStatus.QUEUED }).returning(['id']).execute()
                if (!Array.isArray(updated.raw) || updated.raw.length !== 1) throw error
                // Return, rather than throw, so the refusal is committed without
                // creating a dispatch, reservation, debit or queue job.
                return new HostedRunStartRefused(refused)
            }
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
        if (prepared instanceof HostedRunStartRefused) throw prepared
        return prepared
    }

    async function agentFlowTool({ admissionId, platformId, projectId, toolName, key, payload, queueName }: { admissionId: string, platformId: string, projectId: string, toolName: string, key: string, payload: Record<string, unknown>, queueName: string }) {
        tx.assertKey(key)
        assertPayload(payload)
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId })
            const parent = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId, platformId, projectId })
            const job = parent?.payload
            if (!parent || job?.jobType !== WorkerJobType.EXECUTE_AGENT_RUN || !job.runId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            const selected = job.flowTools?.find(tool => tool.toolName === toolName)
            if (!selected?.flowVersionId) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
            const rootKey = `tool:${digest(JSON.stringify([parent.id, key]))}`
            const requestHash = hashData({ toolName, payload, flowId: selected.flowId, flowVersionId: selected.flowVersionId })
            const existing = await manager.getRepository(HostingDispatchEntity).findOneBy({ platformId, rootKey })
            if (existing) {
                if (existing.requestHash !== requestHash || existing.projectId !== projectId || existing.payload?.jobType !== WorkerJobType.EXECUTE_FLOW) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return { runId: required(existing.flowRunId), data: existing.payload, jobId: required(existing.jobId) }
            }
            const now = await tx.now(manager)
            if (parent.state !== 'running' || parent.terminalReceipt || !parent.leaseUntil || parent.leaseUntil <= now) hostingFail('HOSTING_PARENT_NOT_RUNNING')
            await assertLiveContext({ manager, data: job })
            await tx.member({ manager, actor: actorOf(parent), projectId, write: true })
            tx.assertActive({ account, now })
            const root = await rootOf({ manager, dispatch: parent })
            await assertBound({ manager, root })
            const flow = await manager.getRepository(FlowEntity).findOneBy({ id: selected.flowId, projectId, status: FlowStatus.ENABLED, publishedVersionId: selected.flowVersionId })
            const version = flow && await manager.getRepository(FlowVersionEntity).findOneBy({ id: selected.flowVersionId, flowId: flow.id })
            if (!flow || !version || !('pieceName' in version.trigger.settings) || version.trigger.settings.pieceName !== '@activepieces/piece-mcp') hostingFail('HOSTING_CALLABLE_FLOW_REQUIRED')
            const payer = await currentHostedFlowPayer({ manager, platformId, projectId, flowId: flow.id, flowVersionId: version.id })
            if (payer === 'managed' && root.reservationId && (await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: root.reservationId, platformId })).payer !== 'managed') hostingFail('HOSTING_AI_PAYER_CONFLICT')
            const runId = apId()
            const data = JobData.parse({ schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_FLOW, projectId, platformId, flowId: flow.id, flowVersionId: version.id, runId, executionType: ExecutionType.BEGIN, executeTrigger: true, payload: { type: 'inline', value: payload }, logsFileId: apId(), environment: RunEnvironment.PRODUCTION, streamStepProgress: StreamStepProgress.NONE })
            if (data.jobType !== WorkerJobType.EXECUTE_FLOW) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
            await manager.getRepository(FlowRunEntity).insert({ id: runId, projectId, flowId: flow.id, flowVersionId: version.id, environment: RunEnvironment.PRODUCTION, failParentOnFailure: false, triggeredBy: job.userId, status: FlowRunStatus.QUEUED, tags: [] })
            await manager.getRepository(HostingDispatchEntity).save({ id: apId(), platformId, projectId, identityId: parent.identityId, tokenVersion: parent.tokenVersion, originType: parent.originType, queueKey: deliveryKey({ queueName, jobId: runId }), payloadHash: hashData(data), rootKey, state: 'prepared', flowRunId: runId, rootDispatchId: root.id, parentDispatchId: parent.id, generation: 0, queueName, jobId: runId, payload: data, availableAt: now, requestHash })
            return { runId, data, jobId: runId }
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
                await assertRefreshParent({ manager, dispatch })
                await assertLiveContext({ manager, data })
                await tx.member({ manager, actor: actorOf(dispatch), projectId: dispatch.projectId, write: true, admin: data.jobType === WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION })
                tx.assertActive({ account, now: await tx.now(manager) })
                if (data.jobType === WorkerJobType.EXECUTE_AGENT_RUN && data.source === AgentRunSource.FLOW_STEP) {
                    const point = await manager.getRepository(WaitpointEntity).findOneBy({ id: data.waitpointId, projectId: dispatch.projectId, flowRunId: data.flowRunId })
                    const parent = point?.hostingDispatchId ? await manager.getRepository(HostingDispatchEntity).findOneBy({ id: point.hostingDispatchId, platformId: dispatch.platformId }) : null
                    if (!parent || parent.state !== 'paused') hostingFail('HOSTING_CONCURRENCY_LIMIT')
                }
                const root = await rootOf({ manager, dispatch })
                const siblings = await tree({ manager, root })
                const ancestors = new Set<string>()
                let ancestorId = dispatch.parentDispatchId
                while (ancestorId) {
                    if (ancestors.has(ancestorId) || ancestors.size >= MAX_SEGMENTS) hostingFail('HOSTING_NESTING_LIMIT')
                    ancestors.add(ancestorId)
                    ancestorId = siblings.find(item => item.id === ancestorId)?.parentDispatchId ?? null
                }
                if (siblings.some(item => item.id !== dispatch.id && !ancestors.has(item.id) && ACTIVE.includes(item.state))) hostingFail('HOSTING_CONCURRENCY_LIMIT')
                if (dispatch.parentDispatchId) {
                    const parent = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: dispatch.parentDispatchId, platformId: dispatch.platformId })
                    if (!['completed', 'paused'].includes(parent.state) && !(parent.state === 'running' && ((data.jobType === WorkerJobType.EXECUTE_TOKEN_REFRESH && parent.payload?.jobType !== WorkerJobType.EXECUTE_TOKEN_REFRESH) || (parent.payload?.jobType === WorkerJobType.EXECUTE_AGENT_RUN && data.jobType !== WorkerJobType.EXECUTE_AGENT_RUN) || (parent.payload && isHostedTriggerJob(parent.payload) && data.jobType === WorkerJobType.EXECUTE_TRIGGER_HOOK)))) hostingFail('HOSTING_CONCURRENCY_LIMIT')
                }
                const ledger = createHostedLedger({ dataSource, manager })
                const reservation = root.reservationId
                    ? await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: root.reservationId, platformId: root.platformId })
                    : await ledger.reserveExecution({ actor: actorOf(root), projectId: root.projectId, key: root.rootKey, payer: await currentHostedJobPayer({ manager, platformId: root.platformId, projectId: root.projectId, data: root.payload }) })
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
                await assertRefreshParent({ manager, dispatch })
                await assertLiveContext({ manager, data })
                await tx.member({ manager, actor: actorOf(dispatch), projectId: dispatch.projectId, write: true, admin: data.jobType === WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION })
                const ledger = createHostedLedger({ dataSource, manager })
                // Key removal between reservation and worker start is still a
                // definitive unsent refusal, not a charged/uncertain workflow.
                await currentHostedJobPayer({ manager, platformId: dispatch.platformId, projectId: dispatch.projectId, data: dispatch.payload })
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
            if (dispatch.resolutionStatus) return
            if (dispatch.completionStatus && dispatch.completionStatus !== status) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
            if (!['running', 'uncertain', 'completed', 'paused'].includes(dispatch.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            dispatch.completionStatus = status
            await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { completionStatus: status })
            if (!hasDefinitiveHostedCompletion(dispatch.payload, status)) await uncertain({ manager, dispatch })
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
        let definitelyUnsent = !root.reservationId
        if (dispatch.id === root.id && root.reservationId) {
            const reservation = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: root.reservationId, platformId: root.platformId })
            if (reservation.state === 'reserved') {
                definitelyUnsent = true
                await createHostedLedger({ dataSource, manager }).cancelUnsent({ platformId: root.platformId, reservationId: reservation.id })
            }
        }
        await manager.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { state: 'cancelled' })
        const freshUnsentRoot = definitelyUnsent && dispatch.id === root.id && root.payload?.jobType === WorkerJobType.EXECUTE_FLOW && root.payload.executionType === ExecutionType.BEGIN
        const failedStep = !freshUnsentRoot ? null : reason === 'HOSTING_CREDITS_EXHAUSTED'
            ? { name: 'trigger', displayName: 'Credits', message: 'Not enough Credits are available to start this Mission. Check billing or contact your workspace administrator.' }
            : ['HOSTING_BYOK_SCOPE_DENIED', 'HOSTING_EXACT_BYOK_KEY_REQUIRED'].includes(reason)
                ? { name: 'trigger', displayName: 'AI connection', message: 'The selected client AI key is unavailable for this Mission. Ask your workspace administrator to update its AI connection, then try again.' }
                : null
        if (dispatch.flowRunId) await manager.getRepository(FlowRunEntity).update({ id: dispatch.flowRunId, projectId: dispatch.projectId }, { status: FlowRunStatus.FAILED, finishTime: new Date().toISOString(), ...(failedStep ? { failedStep } : {}) })
        if (definitelyUnsent && dispatch.id === root.id && root.payload?.jobType === WorkerJobType.EXECUTE_AGENT_RUN && root.payload.source !== AgentRunSource.FLOW_STEP) {
            await manager.getRepository(root.payload.source === AgentRunSource.CHAT ? SydConversationEntity : SydAgentConversationEntity).update({ id: root.payload.conversationId, platformId: root.platformId, userId: root.payload.userId, source: root.payload.source, activeRunId: root.payload.runId, status: In([AgentConversationStatus.IDLE, AgentConversationStatus.STREAMING]) }, { status: AgentConversationStatus.ERROR })
        }
        await signalParentFailure({ manager, dispatch, status: FlowRunStatus.FAILED })
        await tx.event({ manager, platformId: dispatch.platformId, event: 'execution.denied', payload: { dispatchId: dispatch.id, reason } })
        await reconcileRoot({ manager, root })
    }

    async function finalize({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }): Promise<void> {
        if (['completed', 'paused'].includes(dispatch.state) || !hasDefinitiveHostedCompletion(dispatch.payload, dispatch.completionStatus)) return
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
            .where('((d.state = \'prepared\' AND d."availableAt" <= clock_timestamp()) OR (d.state IN (\'admitted\', \'running\') AND d."leaseUntil" <= clock_timestamp()) OR (d.state = \'uncertain\' AND d."completionStatus" IS NOT NULL AND d."completionStatus" <> :internal) OR (d.state IN (\'completed\', \'paused\') AND d."rootDispatchId" IS NULL AND r.state IN (\'running\', \'paused\', \'uncertain\')))', { internal: EngineResponseStatus.INTERNAL_ERROR })
            .andWhere('(d.state <> :uncertain OR d.payload->>\'jobType\' NOT IN (:...coordinatorTypes) OR d."completionStatus" IN (:...definitive))', { uncertain: 'uncertain', coordinatorTypes: HOSTED_COORDINATOR_JOB_TYPES, definitive: [EngineResponseStatus.OK, EngineResponseStatus.USER_FAILURE] })
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

    async function resolveHostedHandshakeOrigin({ platformId, projectId, flowId, flowVersionId, test }: { platformId: string, projectId: string, flowId: string, flowVersionId: string, test: boolean }): Promise<HostingJobOrigin> {
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId })
            const candidates = await manager.getRepository(HostingDispatchEntity).createQueryBuilder('dispatch').where({ platformId, projectId, state: 'running' }).andWhere('dispatch.payload->>\'flowId\' = :flowId', { flowId }).andWhere('dispatch.payload->>\'flowVersionId\' = :flowVersionId', { flowVersionId }).getMany()
            const now = await tx.now(manager)
            const parents = candidates.filter(parent => parent.admissionId && parent.leaseUntil && parent.leaseUntil > now && !parent.terminalReceipt && ((parent.payload?.jobType === WorkerJobType.EXECUTE_TRIGGER_HOOK && parent.payload.hookType === TriggerHookType.ON_ENABLE && parent.payload.test === test) || (parent.payload?.jobType === WorkerJobType.RENEW_WEBHOOK && !test)))
            if (parents.length > 1) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
            const parent = parents[0]
            if (!parent?.payload || !isHostedTriggerJob(parent.payload)) return { type: 'scheduled' as const }
            await assertHostedTriggerContext({ manager, data: parent.payload })
            await tx.member({ manager, actor: actorOf(parent), projectId, write: true })
            tx.assertActive({ account, now })
            return { type: 'trigger-lifecycle' as const, admissionId: parent.admissionId! }
        } })
    }

    async function validateScheduledTrigger({ data }: { data: JobData }): Promise<void> {
        if (!isHostedTriggerJob(data) || !data.platformId || !data.projectId) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
        await tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId: data.platformId })
            await assertHostedTriggerContext({ manager, data, registration: true })
            const project = await manager.getRepository(ProjectEntity).findOneBy({ id: data.projectId, platformId: data.platformId })
            const user = project && await manager.getRepository(UserEntity).findOneBy({ id: project.ownerId, platformId: data.platformId })
            if (!user) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
            await tx.member({ manager, actor: { platformId: data.platformId, identityId: user.identityId }, projectId: data.projectId, write: true })
            tx.assertActive({ account, now: await tx.now(manager) })
        } })
    }
    async function assertTriggerCallback({ admissionId, connectionId, projectId, flowVersionId, purpose = 'payload' }: { admissionId?: string, connectionId?: string, projectId: string, flowVersionId: string, purpose?: 'payload' | 'sample' | 'stats' }): Promise<HostedTriggerJob> {
        if (!admissionId || !connectionId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
        return tx.run({ dataSource, fn: async manager => {
            const peek = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId, projectId })
            if (!peek) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            const account = await tx.account({ manager, platformId: peek.platformId })
            const segment = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: peek.id })
            const now = await tx.now(manager)
            if (segment.state !== 'running' || segment.terminalReceipt || segment.connectionId !== connectionId || !segment.leaseUntil || segment.leaseUntil <= now || !segment.payload || !isHostedTriggerJob(segment.payload) || hostedTriggerVersionId(segment.payload) !== flowVersionId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            const data = segment.payload
            if (purpose === 'sample' && (data.jobType !== WorkerJobType.EXECUTE_WEBHOOK || data.execute || !data.saveSampleData)) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            if (purpose === 'payload' && data.jobType !== WorkerJobType.EXECUTE_POLLING && (data.jobType !== WorkerJobType.EXECUTE_WEBHOOK || !data.execute || data.saveSampleData)) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            if (purpose !== 'stats') await assertHostedTriggerContext({ manager, data })
            await tx.member({ manager, actor: actorOf(segment), projectId, write: true })
            tx.assertActive({ account, now })
            return data
        } })
    }
    return { resolveHostedHandshakeOrigin, agentFlowTool, validateScheduledTrigger, assertTriggerCallback, prepare, nested, admit, start, complete, disconnect, cancel, flowReceipt, checkpoint, assertEngineRun, heartbeat, reconcile, recover, expireWaitpoint }
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
async function currentHostedJobPayer({ manager, platformId, projectId, data }: { manager: EntityManager, platformId: string, projectId: string, data: JobData | null }): Promise<'managed' | 'byok'> {
    if (data && isHostedMaintenanceJob(data)) return 'managed'
    if (data?.jobType === WorkerJobType.EXECUTE_ACTION) return currentHostedActionPayer({ manager, platformId, projectId, step: data.step })
    if (data && isHostedTriggerJob(data)) return 'managed'
    if (data?.jobType === WorkerJobType.EXECUTE_FLOW) return currentHostedFlowPayer({ manager, platformId, flowId: data.flowId, flowVersionId: data.flowVersionId, projectId, stepNameToTest: data.stepNameToTest })
    if (data?.jobType !== WorkerJobType.EXECUTE_AGENT_RUN) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
    const unresolved = await manager.getRepository(HostingModelCallEntity).createQueryBuilder('call')
        .innerJoin('hosting_dispatch', 'prior', 'prior."reservationId" = call."rootReservationId" AND prior."platformId" = call."platformId"')
        .where('call."platformId" = :platformId', { platformId })
        .andWhere('call.state IN (:...states)', { states: ['prepared', 'running', 'uncertain'] })
        .andWhere('prior.payload->>\'conversationId\' = :conversationId', { conversationId: data.conversationId })
        .andWhere('prior.payload->>\'runId\' <> :runId', { runId: data.runId }).getExists()
    if (unresolved) hostingFail('HOSTING_AI_OUTCOME_UNCERTAIN')
    if ((!data.provider || data.provider === AIProviderName.ACTIVEPIECES) && !data.providerConfigId) return 'managed'
    if (data.provider !== AIProviderName.DEEPSEEK || !data.providerConfigId) hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
    await hostedAiCredential({ manager, platformId, projectId, payer: { type: 'byok', configId: data.providerConfigId }, model: HOSTED_DEEPSEEK_MODEL })
    // Named Agents may invoke configured managed gadgets or Missions. Each
    // model call still selects its own exact payer; this only permits a managed hold.
    return data.source === AgentRunSource.CHAT ? 'byok' : 'managed'
}

async function assertLiveContext({ manager, data }: { manager: EntityManager, data: JobData }): Promise<void> {
    if (isHostedTriggerJob(data)) await assertHostedTriggerContext({ manager, data })
    if ('piece' in data && data.piece && 'platformId' in data.piece && data.piece.platformId && data.piece.platformId !== data.platformId) hostingFail('HOSTING_PIECE_SCOPE_MISMATCH')
    if (data.jobType === WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION && 'archiveId' in data.piece) {
        const archive = await manager.getRepository(FileEntity).findOneBy({ id: data.piece.archiveId, platformId: data.platformId, type: FileType.PACKAGE_ARCHIVE })
        if (!archive) hostingFail('HOSTING_PIECE_SCOPE_MISMATCH')
    }
    if (data.jobType === WorkerJobType.EXECUTE_TOKEN_REFRESH) await assertHostedRefreshContext({ manager, data })
    if (data.jobType === WorkerJobType.EXECUTE_PROPERTY && data.flowVersion) {
        const flow = await manager.getRepository(FlowEntity).findOneBy({ id: data.flowVersion.flowId, projectId: data.projectId })
        const version = await manager.getRepository(FlowVersionEntity).findOneBy({ id: data.flowVersion.id, flowId: data.flowVersion.flowId })
        if (!flow || !version || hashData(FlowVersion.parse(version)) !== hashData(data.flowVersion)) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
    }
    if (data.jobType === WorkerJobType.EXECUTE_AGENT_RUN) {
        const conversation = await manager.getRepository(data.source === AgentRunSource.CHAT ? SydConversationEntity : SydAgentConversationEntity).findOneBy({ id: data.conversationId, platformId: data.platformId, userId: data.userId, source: data.source, activeRunId: data.runId })
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
export type HostingJobOrigin = { type: 'user', userId: string, tokenVersion?: string | null } | { type: 'operator-maintenance', userId: string, tokenVersion: string | null } | { type: 'connection-refresh', connectionId: string, credentialRevision: string, parentAdmissionId?: string, userId?: string, tokenVersion?: string | null } | { type: 'scheduled' } | { type: 'resume', waitpointId: string } | { type: 'agent-step', admissionId: string, waitpointId: string } | { type: 'agent-tool', admissionId: string, key: string } | { type: 'trigger-lifecycle', admissionId: string }

type HostedTriggerJob = Extract<JobData, { jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK | WorkerJobType.EXECUTE_POLLING | WorkerJobType.RENEW_WEBHOOK | WorkerJobType.EXECUTE_WEBHOOK }>
function isHostedTriggerJob(data: JobData): data is HostedTriggerJob {
    return [WorkerJobType.EXECUTE_TRIGGER_HOOK, WorkerJobType.EXECUTE_POLLING, WorkerJobType.RENEW_WEBHOOK, WorkerJobType.EXECUTE_WEBHOOK].includes(data.jobType)
}
function hostedTriggerVersionId(data: HostedTriggerJob): string {
    return data.jobType === WorkerJobType.EXECUTE_WEBHOOK ? data.flowVersionIdToRun : data.flowVersionId
}
async function assertHostedTriggerContext({ manager, data, registration = false }: { manager: EntityManager, data: HostedTriggerJob, registration?: boolean }): Promise<void> {
    const versionId = hostedTriggerVersionId(data)
    if (data.jobType === WorkerJobType.EXECUTE_WEBHOOK && (data.parentRunId || data.failParentOnFailure || !((data.execute && !data.saveSampleData && data.runEnvironment === RunEnvironment.PRODUCTION) || (!data.execute && data.saveSampleData && data.runEnvironment === RunEnvironment.TESTING)))) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
    const flow = await manager.getRepository(FlowEntity).findOneBy({ id: data.flowId, projectId: data.projectId })
    const version = await manager.getRepository(FlowVersionEntity).findOneBy({ id: versionId, flowId: data.flowId })
    if (data.jobType === WorkerJobType.EXECUTE_TRIGGER_HOOK && data.hookType === TriggerHookType.TEST) {
        if (!flow || !version) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
        return
    }
    const source = await manager.getRepository(TriggerSourceEntity).findOneBy({ flowId: data.flowId, flowVersionId: versionId, projectId: data.projectId, simulate: data.jobType === WorkerJobType.EXECUTE_TRIGGER_HOOK ? data.test : data.jobType === WorkerJobType.EXECUTE_WEBHOOK && data.saveSampleData })
    const project = await manager.getRepository(ProjectEntity).findOneBy({ id: data.projectId, platformId: data.platformId })
    if (!project || !flow || !version || !source || !('triggerName' in version.trigger.settings) || source.triggerName !== version.trigger.settings.triggerName || !('pieceName' in version.trigger.settings) || source.pieceName !== version.trigger.settings.pieceName || source.pieceVersion !== version.trigger.settings.pieceVersion) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
    if (!registration && data.jobType !== WorkerJobType.EXECUTE_TRIGGER_HOOK && !(data.jobType === WorkerJobType.EXECUTE_WEBHOOK && data.saveSampleData) && (flow.status !== FlowStatus.ENABLED || flow.publishedVersionId !== versionId)) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
}

export function hostedConnectionRevision(connection: { id: string, updated: string | Date, value: unknown }): string {
    return hashData({ id: connection.id, updated: connection.updated, value: connection.value })
}

async function assertHostedRefreshContext({ manager, data }: { manager: EntityManager, data: Extract<JobData, { jobType: WorkerJobType.EXECUTE_TOKEN_REFRESH }> }): Promise<void> {
    if (!data.hostingConnectionId || !data.hostingConnectionRevision || !data.projectId) hostingFail('HOSTING_CONNECTION_PROVENANCE_REQUIRED')
    const connection = await manager.getRepository(AppConnectionEntity).findOneBy({ id: data.hostingConnectionId, platformId: data.platformId, projectIds: ArrayContains([data.projectId]) })
    if (!connection || hostedConnectionRevision(connection) !== data.hostingConnectionRevision || connection.pieceName !== data.piece.pieceName || connection.pieceVersion !== data.piece.pieceVersion || hashData(await encryptUtils.decryptObject(connection.value)) !== hashData(data.connectionValue)) hostingFail('HOSTING_CONNECTION_REVISION_MISMATCH')
}

async function assertRefreshParent({ manager, dispatch }: { manager: EntityManager, dispatch: HostingDispatch }): Promise<void> {
    if (dispatch.payload?.jobType !== WorkerJobType.EXECUTE_TOKEN_REFRESH || !dispatch.parentDispatchId) return
    const parent = await manager.getRepository(HostingDispatchEntity).findOneBy({ id: dispatch.parentDispatchId, platformId: dispatch.platformId, projectId: dispatch.projectId, state: 'running' })
    if (!parent?.payload || parent.payload.jobType === WorkerJobType.EXECUTE_TOKEN_REFRESH || parent.terminalReceipt || !parent.leaseUntil || parent.leaseUntil <= await tx.now(manager)) hostingFail('HOSTING_PARENT_NOT_RUNNING')
    await assertLiveContext({ manager, data: parent.payload })
}
