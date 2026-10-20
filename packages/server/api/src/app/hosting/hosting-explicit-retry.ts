import { createHash } from 'node:crypto'
import { ExecutionType, FlowRetryStrategy, FlowRun, FlowRunStatus, JobPayload, WorkerJobType } from '@activepieces/shared'
import { DataSource, In } from 'typeorm'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { UserEntity } from '../user/user-entity'
import { HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingReservationEntity } from './hosting-entities'
import type { HostingJobOrigin } from './hosting-execution'
import { hostedFlowPayer } from './hosting-flow-payer'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { hostingFail, hostingTransactions as tx } from './hosting-transactions'

// One explicit successor per failed run. A repeated click returns that successor;
// a further deliberate retry must target the failed successor, never the old run.
export function hostedRetryRunId(platformId: string, projectId: string, failedRunId: string): string {
    return createHash('sha256').update(JSON.stringify(['hosted-full-retry-v1', platformId, projectId, failedRunId])).digest('hex').slice(0, 21)
}

export function createHostedExplicitRetry({ dataSource }: { dataSource: DataSource }) {
    return {
        async prepare({ platformId, projectId, flowRunId, flowVersionId, strategy, origin, hasTriggerPayload }: Params): Promise<{ run: FlowRun, enqueue: boolean, logsFileId: string, unsent: { payload: JobPayload, executeTrigger: boolean } | null }> {
            if (strategy !== FlowRetryStrategy.ON_LATEST_VERSION) hostingFail('HOSTING_FULL_WORKFLOW_RETRY_REQUIRED')
            if (origin?.type !== 'user' || origin.tokenVersion === undefined) hostingFail('HOSTING_JOB_PROVENANCE_REQUIRED')
            return tx.run({ dataSource, fn: async manager => {
                const account = await tx.account({ manager, platformId })
                const user = await manager.getRepository(UserEntity).findOneBy({ id: origin.userId, platformId })
                if (!user) hostingFail('HOSTING_ACCESS_DENIED')
                await tx.member({ manager, actor: { platformId, identityId: user.identityId, tokenVersion: origin.tokenVersion }, projectId, write: true })
                const now = await tx.now(manager)
                tx.assertActive({ account, now })
                const oldRun = await manager.getRepository(FlowRunEntity).findOneBy({ id: flowRunId, projectId })
                if (!oldRun || oldRun.status !== FlowRunStatus.FAILED || !oldRun.finishTime || oldRun.parentRunId || oldRun.stepNameToTest) hostingFail('HOSTING_TERMINAL_ROOT_RETRY_REQUIRED')
                if (!await manager.getRepository(FlowEntity).existsBy({ id: oldRun.flowId, projectId })) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
                const latest = await manager.getRepository(FlowVersionEntity).findOne({ where: { id: flowVersionId, flowId: oldRun.flowId }, lock: { mode: 'pessimistic_read' } })
                const original = await manager.getRepository(FlowVersionEntity).findOneBy({ id: oldRun.flowVersionId, flowId: oldRun.flowId })
                if (!latest || !original || hostedFlowPayer(original) !== hostedFlowPayer(latest)) hostingFail('HOSTING_RETRY_PAYER_CHANGED')
                const root = await manager.getRepository(HostingDispatchEntity).findOneBy({ platformId, projectId, flowRunId, generation: 0 })
                if (!root || root.rootDispatchId || root.payload?.jobType !== WorkerJobType.EXECUTE_FLOW || root.payload.executionType !== ExecutionType.BEGIN || root.payload.stepNameToTest) hostingFail('HOSTING_RETRY_RECEIPT_REQUIRED')
                const segments = await manager.getRepository(HostingDispatchEntity).find({ where: [{ id: root.id, platformId }, { rootDispatchId: root.id, platformId }] })
                const definitelyUnsent = segments.length === 1 && root.state === 'cancelled' && !root.reservationId && !root.admissionId && !root.dispatchId && !root.connectionId
                if (definitelyUnsent) {
                    if (await manager.getRepository(HostingModelCallEntity).existsBy({ platformId, segmentId: root.id })) hostingFail('HOSTING_RETRY_PRIOR_WORK_UNRESOLVED')
                }
                else {
                    const latestSegment = segments.filter(value => value.flowRunId === flowRunId).sort((a, b) => b.generation - a.generation)[0]
                    if (!latestSegment || !root.reservationId || (latestSegment.terminalReceipt !== FlowRunStatus.FAILED && latestSegment.resolutionStatus !== FlowRunStatus.FAILED) || segments.some(value => !['completed', 'cancelled'].includes(value.state))) hostingFail('HOSTING_RETRY_PRIOR_WORK_UNRESOLVED')
                    const reservation = await manager.getRepository(HostingReservationEntity).findOneBy({ id: root.reservationId, platformId })
                    if (!reservation || reservation.state !== 'settled' || reservation.payer !== hostedFlowPayer(original)) hostingFail('HOSTING_RETRY_PRIOR_WORK_UNRESOLVED')
                    if (await manager.getRepository(HostingModelCallEntity).existsBy({ platformId, rootReservationId: reservation.id, state: In(['prepared', 'running', 'uncertain']) }) ||
                        await manager.getRepository(HostingReservationEntity).existsBy({ platformId, rootReservationId: reservation.id, state: In(['reserved', 'running', 'uncertain', 'paused']) })) hostingFail('HOSTING_RETRY_PRIOR_WORK_UNRESOLVED')
                }
                if (hasTriggerPayload === false && !definitelyUnsent) hostingFail('HOSTING_RETRY_TRIGGER_PAYLOAD_REQUIRED')
                const unsent = definitelyUnsent ? { payload: root.payload.payload, executeTrigger: root.payload.executeTrigger ?? false } : null
                const id = hostedRetryRunId(platformId, projectId, flowRunId)
                const logsFileId = createHash('sha256').update(`hosted-retry-logs:${id}`).digest('hex').slice(0, 21)
                const existing = await manager.getRepository(FlowRunEntity).findOneBy({ id, projectId, flowId: oldRun.flowId })
                if (existing) {
                    const dispatched = await manager.getRepository(HostingDispatchEntity).existsBy({ platformId, projectId, flowRunId: id })
                    // A crash before prepare can safely reconstruct an unsent job.
                    // Once a durable dispatch exists its recovery owns delivery.
                    return { run: existing, enqueue: existing.status === FlowRunStatus.QUEUED && !dispatched, logsFileId, unsent }
                }
                const run = await manager.getRepository(FlowRunEntity).save({
                    id, projectId, flowId: oldRun.flowId, flowVersionId: latest.id,
                    environment: oldRun.environment, triggeredBy: origin.userId,
                    failParentOnFailure: true, parentRunId: undefined, status: FlowRunStatus.QUEUED,
                    // The worker creates the file before flowReceipt binds its FK.
                    // Keep only the deterministic job ID until that file exists.
                    created: now.toISOString(), updated: now.toISOString(), tags: [], steps: {},
                })
                await tx.event({ manager, platformId, event: 'execution.explicit_retry', payload: { priorRunId: flowRunId, runId: run.id, projectId, userId: origin.userId } })
                return { run, enqueue: true, logsFileId, unsent }
            } })
        },
    }
}

type Params = { platformId: string, projectId: string, flowRunId: string, flowVersionId: string, strategy: FlowRetryStrategy, origin?: HostingJobOrigin, hasTriggerPayload?: boolean }
