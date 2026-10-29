import { assertNotNullOrUndefined, isNil, spreadIfDefined } from '@activepieces/core-utils'
import { apVersionUtil, onCallService, UNKNOWN_VERSION } from '@activepieces/server-utils'
import { AgentEventType, AgentRunSource, ExecutionType, FileCompression, FileLocation, FileType, FlowOperationType, FlowStatus, RunEnvironment, WebsocketClientEvent, WorkerGroupScope, WorkerProps, WorkerToApiContract } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { aiRpcHandlers } from '../../ai/ai-rpc-handlers'
import { websocketService } from '../../core/websockets.service'
import { distributedStore, redisConnections } from '../../database/redis-connections'
import { eventDestinationRpcHandlers } from '../../event-destinations/event-destinations-rpc-handlers'
import { fileService, getLocationForFile } from '../../file/file.service'
import { s3Helper } from '../../file/s3-helper'
import { signedFileTransport } from '../../file/signed-file-transport'
import { flowSideEffects } from '../../flows/flow/flow-service-side-effects'
import { flowService } from '../../flows/flow/flow.service'
import { engineRunCallbackService } from '../../flows/flow-run/engine-run-callback-service'
import { flowRunService } from '../../flows/flow-run/flow-run-service'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { EMPTY_PREWARM_RESPONSE, preWarmWorkersService } from '../../flows/pre-warm-workers'
import { rejectedPromiseHandler } from '../../helper/promise-handler'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { protectHostedCopilotRpc } from '../../hosting/hosting-copilot'
import { hostedRunCallback } from '../../hosting/hosting-run-callback'
import { hostingServices } from '../../hosting/hosting-services'
import { hostingFail } from '../../hosting/hosting-transactions'
import { hostingWorkerGate } from '../../hosting/hosting-worker-gate'
import { pieceMetadataService } from '../../pieces/metadata/piece-metadata-service'
import { shouldBlockRunOnCredits } from '../../platform/billing-provider'
import { projectService } from '../../project/project-service'
import { sydAgentRpcHandlers } from '../../syd/copilot/agent-rpc-handlers'
import { sydCopilotContext } from '../../syd/copilot/copilot-context'
import { sydCopilotRpcHandlers } from '../../syd/copilot/copilot-rpc-handlers'
import { sydPersonalizationService } from '../../syd/copilot/personalization/personalization-service'
import { dedupeService } from '../../trigger/dedupe-service'
import { triggerEventService } from '../../trigger/trigger-events/trigger-event.service'
import { triggerRunStats } from '../../trigger/trigger-run/trigger-run-stats'
import { triggerSourceService } from '../../trigger/trigger-source/trigger-source-service'
import { getPlatformGroupQueueName, getProjectGroupQueueName, QueueName, WorkerGroupAssignment } from '../job'
import { jobBroker } from '../job-queue/job-broker'
import { machineService } from '../machine/machine-service'

const FLOW_BUNDLE_PUBLISH_CLAIM_TTL_SECONDS = 60

const getFlowBundlePublishClaimKey = (flowVersionId: string): string => `flow_bundle_publish_claim:${flowVersionId}`

const getPollQueueName = (assignment: WorkerGroupAssignment | null): string => {
    if (isNil(assignment)) {
        return QueueName.WORKER_JOBS
    }
    return assignment.scope === WorkerGroupScope.PROJECT
        ? getProjectGroupQueueName(assignment.id)
        : getPlatformGroupQueueName(assignment.id)
}

let pagedForUnreadableAppVersion = false

function pageOnceForUnreadableAppVersion(log: FastifyBaseLogger, appVersion: string): void {
    if (pagedForUnreadableAppVersion) {
        return
    }
    pagedForUnreadableAppVersion = true
    onCallService(log, system.get(AppSystemProp.PAGE_ONCALL_WEBHOOK)).page({
        code: 'APP_VERSION_READ_FAILED',
        message: 'App could not read its release version from package.json (reported as 0.0.0); worker dispatch is gated and will NOT self-heal until the deployment is fixed (check cwd/packaging)',
        params: { appVersion },
    }).catch((pageError) => {
        log.error({ pageError }, '[workerRpc] Failed to send on-call page for unreadable app version')
    })
}

function workerVersionIsCompatible({ log, workerVersion, workerId, rpcMethod }: WorkerVersionGateParams): boolean {
    const appVersion = apVersionUtil.getCurrentRelease()
    if (apVersionUtil.versionsAreCompatible({ versionA: workerVersion, versionB: appVersion })) {
        return true
    }
    const versionUnreadable = workerVersion === UNKNOWN_VERSION || appVersion === UNKNOWN_VERSION
    const logFields = { ...spreadIfDefined('worker', isNil(workerId) ? undefined : { id: workerId }), workerVersion, appVersion }
    if (versionUnreadable) {
        log.error(logFields, `[workerRpc#${rpcMethod}] Withholding work — a release version could not be read from package.json (reported as 0.0.0); this will NOT self-heal on deploy completion, check the worker/app deployment (cwd/packaging)`)
    }
    else {
        log.warn(logFields, `[workerRpc#${rpcMethod}] Withholding work — worker version does not match app; worker will idle until upgraded`)
    }
    if (appVersion === UNKNOWN_VERSION) {
        pageOnceForUnreadableAppVersion(log, appVersion)
    }
    return false
}

export function createHandlers(log: FastifyBaseLogger, assignment: WorkerGroupAssignment | null = null, connectionId?: string, workerProps?: WorkerProps, connectionSignal?: AbortSignal): WorkerToApiContract {
    const connectionWorkerProps = Object.freeze({ ...workerProps })
    const connectionIsCompatible = () => !connectionSignal?.aborted && hostingWorkerGate.isCompatible({ workerProps: connectionWorkerProps })
    return protectHostedCopilotRpc({
        async poll(input) {
            if (!connectionIsCompatible() || !hostingWorkerGate.isCompatible({ workerProps: input.workerProps })) return null
            log.info({ worker: { id: input.workerId }, workerGroup: assignment ?? undefined }, '[workerRpc#poll] Poll request received')
            await machineService(log).onConnection(input, assignment)
            if (!workerVersionIsCompatible({ log, workerVersion: input.workerProps.version, workerId: input.workerId, rpcMethod: 'poll' })) {
                return null
            }
            if (input.hostedLane && (hostingConfiguration.getServiceMode() !== 'hosted' || assignment)) return null
            const pollQueueName = input.hostedLane ? `workerJobs-${input.hostedLane}` : getPollQueueName(assignment)
            const job = await jobBroker(log).poll(pollQueueName, connectionId, connectionSignal)
            if (job) {
                log.info({ worker: { id: input.workerId }, job: { id: job.jobId, type: job.jobData.jobType } }, '[workerRpc#poll] Returning job to worker')
            }
            else {
                log.debug({ worker: { id: input.workerId } }, '[workerRpc#poll] No job available, returning null')
            }
            return job
        },

        async startJob(input) {
            if (isNil(connectionId) || !connectionIsCompatible()) return false
            return jobBroker(log).startJob(input, connectionId)
        },

        async completeJob(input) {
            if (!connectionIsCompatible()) hostingFail('HOSTING_WORKER_INCOMPATIBLE')
            log.info({ job: { id: input.jobId }, status: input.status }, '[workerRpc#completeJob] Job completed by worker')
            await jobBroker(log).completeJob(input, connectionId)
        },

        async uploadRunLog(input) {
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                if (!input.admissionId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
                await hostedRunCallback({ log, admissionId: input.admissionId, connectionId, projectId: input.projectId, request: input })
                return
            }
            await engineRunCallbackService(log).uploadRunLog({ projectId: input.projectId, request: input })
        },

        async submitPayloads(input) {
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                if (input.payloads.length > 100 || Buffer.byteLength(JSON.stringify(input.payloads), 'utf8') > 1024 * 1024) hostingFail('HOSTING_PAYLOAD_LIMIT')
                if (!connectionIsCompatible() || !input.admissionId || input.parentRunId || input.failParentOnFailure || input.environment !== RunEnvironment.PRODUCTION) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
                await hostingServices.execution().assertTriggerCallback({ admissionId: input.admissionId, connectionId, projectId: input.projectId, flowVersionId: input.flowVersionId })
            }
            const { flowVersionId, projectId, payloads, httpRequestId, streamStepProgress, environment, parentRunId, failParentOnFailure } = input

            const flowVersion = await flowVersionService(log).getOne(flowVersionId)
            if (!flowVersion) {
                return []
            }

            const platformId = await projectService(log).getPlatformId(projectId)
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                const flow = await flowService(log).getOne({ id: flowVersion.flowId, projectId })
                if (!flow || flow.status !== FlowStatus.ENABLED || flow.publishedVersionId !== flowVersionId) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
            }
            const filterPayloads = await dedupeService.filterUniquePayloads(flowVersionId, payloads)

            const creditsExhausted = await shouldBlockRunOnCredits({
                platformId,
                environment,
                log,
            })

            const flowRuns = await Promise.all(
                filterPayloads.map((payload) =>
                    creditsExhausted
                        ? flowRunService(log).createQuotaExceededRun({
                            flowVersion,
                            payload,
                            projectId,
                            environment,
                            parentRunId,
                            failParentOnFailure,
                            shouldExecuteTriggerOnRetry: false,
                        })
                        : flowRunService(log).start({
                            hostedOrigin: { type: 'scheduled' },
                            flowId: flowVersion.flowId,
                            environment,
                            flowVersionId,
                            payload,
                            projectId,
                            platformId,
                            httpRequestId,
                            workerHandlerId: undefined,
                            executionType: ExecutionType.BEGIN,
                            streamStepProgress,
                            executeTrigger: false,
                            parentRunId,
                            failParentOnFailure,
                        }),
                ),
            )
            return flowRuns
        },

        async savePayloads(input) {
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                if (!connectionIsCompatible() || input.payloads.length > 100 || Buffer.byteLength(JSON.stringify(input.payloads), 'utf8') > 1024 * 1024) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
                const data = await hostingServices.execution().assertTriggerCallback({ admissionId: input.admissionId, connectionId, projectId: input.projectId, flowVersionId: input.flowVersionId, purpose: 'sample' })
                if (data.flowId !== input.flowId) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
            }
            const { flowId, projectId, payloads } = input
            const savePayloads = payloads.map((payload) => triggerEventService(log).saveEvent({ flowId, payload, projectId }))
            if (hostingConfiguration.getServiceMode() === 'hosted') await Promise.all(savePayloads)
            else rejectedPromiseHandler(Promise.all(savePayloads.map(promise => rejectedPromiseHandler(promise, log))), log)
            if (payloads.length > 0) {
                await triggerSourceService(log).disable({
                    flowId,
                    projectId,
                    simulate: true,
                    ignoreError: true,
                    ...(hostingConfiguration.getServiceMode() === 'hosted' ? { hostedOrigin: { type: 'trigger-lifecycle' as const, admissionId: input.admissionId! } } : {}),
                })
            }
        },

        async getFlowVersion(input) {
            const flowVersion = await flowVersionService(log).getOne(input.versionId)
            if (isNil(flowVersion)) {
                return null
            }
            const flow = await flowService(log).getOneById(flowVersion.flowId)
            if (isNil(flow)) {
                return null
            }
            return flowVersion
        },

        async getPiece(input) {
            return pieceMetadataService(log).get({
                name: input.name,
                version: input.version,
                projectId: input.projectId,
                platformId: input.platformId,
            })
        },

        async recordTriggerRun(input) {
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                if (!connectionIsCompatible() || !input.projectId || !input.flowVersionId || !input.admissionId) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
                await hostingServices.execution().assertTriggerCallback({ admissionId: input.admissionId, connectionId, projectId: input.projectId, flowVersionId: input.flowVersionId, purpose: 'stats' })
                const version = await flowVersionService(log).getOne(input.flowVersionId)
                const platformId = await projectService(log).getPlatformId(input.projectId)
                if (!version || !('pieceName' in version.trigger.settings) || version.trigger.settings.pieceName !== input.pieceName || platformId !== input.platformId) hostingFail('HOSTING_TRIGGER_SCOPE_MISMATCH')
            }
            const redisConnection = await redisConnections.useExisting()
            await triggerRunStats(log, redisConnection).save(input)
        },

        async getPrewarmData(input) {
            if (!connectionIsCompatible()) return EMPTY_PREWARM_RESPONSE
            if (!workerVersionIsCompatible({ log, workerVersion: input.workerVersion, rpcMethod: 'getPrewarmData' })) {
                return EMPTY_PREWARM_RESPONSE
            }
            return preWarmWorkersService(log).getPrewarmData(input)
        },

        async getPrewarmScopeFile(input) {
            if (!connectionIsCompatible()) return null
            const file = await fileService(log).getFile({
                fileId: input.fileId,
                type: FileType.PREWARM_SCOPE,
            })
            if (isNil(file)) {
                return null
            }
            if (signedFileTransport.isEnabled(file)) {
                assertNotNullOrUndefined(file.s3Key, 's3Key')
                const url = await s3Helper(log).getS3SignedUrl(file.s3Key, file.fileName ?? file.id)
                return { kind: 'url', url }
            }
            const { data } = await fileService(log).getDataOrThrow({
                fileId: input.fileId,
                type: FileType.PREWARM_SCOPE,
            })
            return { kind: 'inline', data }
        },

        async extendLock(input) {
            if (!connectionIsCompatible()) return
            await jobBroker(log).extendLock(input, connectionId)
        },

        async getPieceArchive(input) {
            const { data } = await fileService(log).getDataOrThrow({
                fileId: input.archiveId,
                type: FileType.PACKAGE_ARCHIVE,
            })
            return data
        },

        async getFlowBundle(input) {
            // Two intentional lookups (not the redundant double-read): the metadata
            // read decides the transport, so S3-backed bundles never load their bytes
            // into app memory — the worker pulls them straight from S3 via a signed URL.
            const file = await fileService(log).getFile({
                fileId: input.flowVersionId,
                projectId: input.projectId,
                type: FileType.FLOW_BUNDLE,
            })
            if (isNil(file)) {
                return null
            }
            if (signedFileTransport.isEnabled(file)) {
                assertNotNullOrUndefined(file.s3Key, 's3Key')
                const url = await s3Helper(log).getS3SignedUrl(file.s3Key, file.fileName ?? file.id)
                return { kind: 'url', url }
            }
            const { data } = await fileService(log).getDataOrThrow({
                fileId: input.flowVersionId,
                projectId: input.projectId,
                type: FileType.FLOW_BUNDLE,
            })
            return { kind: 'inline', data }
        },

        async prepareFlowBundleUpload(input) {
            // Bundles are only worth persisting on S3-backed storage. On DB storage the
            // bundle would just bloat the database (and a null-data pre-save would throw),
            // so tell the worker to skip publishing and always build inline.
            if (getLocationForFile(FileType.FLOW_BUNDLE) !== FileLocation.S3) {
                return { kind: 'skip' }
            }
            // The bundle for a flowVersionId is immutable, and a burst of workers can
            // finish provisioning the same version at once. Only the first claimer
            // publishes; losing the claim is a normal outcome, not an error. Without
            // this, concurrent callers race the deterministic file PK (duplicate key
            // on the file table) and hammer the same S3 key (503 Slow Down). The
            // claim expires so a publish that died mid-upload gets retried.
            const claimed = await distributedStore.putIfAbsent(getFlowBundlePublishClaimKey(input.flowVersionId), 1, FLOW_BUNDLE_PUBLISH_CLAIM_TTL_SECONDS)
            if (!claimed) {
                return { kind: 'skip' }
            }
            // S3 without signed URLs: the worker streams the bytes back via uploadFlowBundle.
            if (!signedFileTransport.shouldRedirectForType(FileType.FLOW_BUNDLE)) {
                return { kind: 'inline' }
            }
            // Signed-PUT path: persist the row (data null) so the s3Key exists, then
            // hand back a signed PUT URL for a direct-to-S3 upload.
            const file = await fileService(log).save({
                fileId: input.flowVersionId,
                projectId: input.projectId,
                platformId: input.platformId,
                type: FileType.FLOW_BUNDLE,
                data: null,
                size: input.size,
                compression: FileCompression.NONE,
            })
            assertNotNullOrUndefined(file.s3Key, 's3Key')
            const url = await s3Helper(log).putS3SignedUrl({
                s3Key: file.s3Key,
                contentLength: input.size,
            })
            return { kind: 'url', url }
        },

        async uploadFlowBundle(input) {
            await fileService(log).save({
                fileId: input.flowVersionId,
                projectId: input.projectId,
                platformId: input.platformId,
                type: FileType.FLOW_BUNDLE,
                data: input.data,
                size: input.data.length,
                compression: FileCompression.NONE,
            })
        },

        async disableFlow(input) {
            const { flowId, projectId } = input
            const flow = await flowService(log).getOneOrThrow({ id: flowId, projectId })
            if (flow.status === FlowStatus.DISABLED) {
                return
            }
            const platformId = await projectService(log).getPlatformId(projectId)
            const disabledFlow = await flowService(log).update({
                id: flowId,
                userId: null,
                projectId,
                platformId,
                emitEvents: false,
                operation: {
                    type: FlowOperationType.CHANGE_STATUS,
                    request: { status: FlowStatus.DISABLED },
                },
            })
            flowSideEffects(log).onDisabledByWorker({ flow: disabledFlow, projectId, platformId })
            log.info({ flow: { id: flowId }, project: { id: projectId } }, '[workerRpc#disableFlow] Flow disabled by worker request')
        },

        async sendAgentEvent(input) {
            const { userId, conversationId, runId, event } = input
            // Admission and authorized rename own titles, including while older
            // workers finish requests during an update. Do not rewind clients
            // with their late model-generated title events.
            if (event.type === AgentEventType.TITLE_UPDATE) return
            websocketService.to(userId).emit(WebsocketClientEvent.CHAT_MESSAGE_CHUNK, {
                conversationId,
                runId,
                ...event,
            })
        },

        async getAgentConfig(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, input), conversationId: input.conversationId, source: input.source })).getAgentConfig(input)
        },

        async saveAgentMessages(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, input), conversationId: input.conversationId })).saveAgentMessages(input)
        },

        async saveAgentFile(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, input), conversationId: input.conversationId })).saveAgentFile(input)
        },

        async readAgentFile(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, input), conversationId: input.conversationId })).readAgentFile(input)
        },

        async updateAgentProgress(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, input), conversationId: input.conversationId })).updateAgentProgress(input)
        },

        async heartbeatAgentConversation(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, input), conversationId: input.conversationId })).heartbeatAgentConversation(input)
        },
        async agentCreditsLeft(input) {
            return sydCopilotRpcHandlers(agentRpcLog(log, input)).agentCreditsLeft(input)
        },

        async updateProjectContext(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, input), conversationId: input.conversationId })).updateProjectContext(input)
        },

        async executeAgentTool(input) {
            const runId = typeof input.toolInput.runId === 'string' ? input.toolInput.runId : undefined
            const conversationId = input.conversationId ?? (typeof input.toolInput.conversationId === 'string' ? input.toolInput.conversationId : undefined)
            return (await agentHandlersForConversation({ log: agentRpcLog(log, { conversationId, runId, platformId: input.platformId, userId: input.userId }), conversationId, source: input.source })).executeAgentTool(input)
        },

        async executePieceTool(input) {
            return configuredAgentHandlers(agentRpcLog(log, { conversationId: input.conversationId })).executePieceTool(input)
        },

        async executeKnowledgeBaseTool(input) {
            return configuredAgentHandlers(agentRpcLog(log, { conversationId: input.conversationId })).executeKnowledgeBaseTool(input)
        },

        async executeFlowTool(input) {
            return configuredAgentHandlers(agentRpcLog(log, { conversationId: input.conversationId })).executeFlowTool(input)
        },

        async updateFlowStepProgress(input) {
            return configuredAgentHandlers(agentRpcLog(log, { conversationId: input.conversationId })).updateFlowStepProgress(input)
        },

        async resolveAiProvider(input) {
            return aiRpcHandlers(log).resolveAiProvider(input)
        },
        async resolveAiModelCandidates(input) {
            return aiRpcHandlers(log).resolveAiModelCandidates(input)
        },
        async reportAiKeyOutcome(input) {
            return aiRpcHandlers(log).reportAiKeyOutcome(input)
        },
        async resolveEventDestinationHeaders(input) {
            return eventDestinationRpcHandlers(log).resolveEventDestinationHeaders(input)
        },
        async saveFlowStepFile(input) {
            return aiRpcHandlers(log).saveFlowStepFile(input)
        },
        async readFlowStepFile(input) {
            return aiRpcHandlers(log).readFlowStepFile(input)
        },
        async reportAiUsage(input) {
            return aiRpcHandlers(log).reportAiUsage(input)
        },
        async resumeAiStep(input) {
            return aiRpcHandlers(log).resumeAiStep(input)
        },
        async resumeFlowStep(input) {
            return configuredAgentHandlers(agentRpcLog(log, { conversationId: input.conversationId })).resumeFlowStep(input)
        },

        async sendAgentEmail(input) {
            return (await agentHandlersForConversation({ log: agentRpcLog(log, { conversationId: input.conversationId, platformId: input.platformId, userId: input.userId }), conversationId: input.conversationId })).sendAgentEmail(input)
        },

        async getPersonalizationConfig(input) {
            return sydPersonalizationService(log).getConfigForWorker(input)
        },

        async getPersonalizationPrefillConfig(input) {
            return sydPersonalizationService(log).getPrefillConfigForWorker(input)
        },

        async savePersonalizationResult(input) {
            return sydPersonalizationService(log).saveResult(input)
        },

        async savePersonalizationPrefill(input) {
            return sydPersonalizationService(log).savePrefill(input)
        },

        async sendPersonalizationProgress(input) {
            return sydPersonalizationService(log).sendProgress(input)
        },
    }, connectionId)
}

// Binds conversation/run/platform/user to the per-call logger so every chat RPC
// log line correlates with the worker turn and the analyze-logs timeline.
function agentRpcLog(log: FastifyBaseLogger, ids: { conversationId?: string, runId?: string, platformId?: string, userId?: string }): FastifyBaseLogger {
    return log.child({
        ...spreadIfDefined('conversation', isNil(ids.conversationId) ? undefined : { id: ids.conversationId }),
        ...spreadIfDefined('run', isNil(ids.runId) ? undefined : { id: ids.runId }),
        ...spreadIfDefined('platform', isNil(ids.platformId) ? undefined : { id: ids.platformId }),
        ...spreadIfDefined('user', isNil(ids.userId) ? undefined : { id: ids.userId }),
    })
}

type WorkerVersionGateParams = {
    log: FastifyBaseLogger
    workerVersion: string | undefined
    workerId?: string
    rpcMethod: string
}

async function agentHandlersForConversation({ log, conversationId, source }: { log: FastifyBaseLogger, conversationId?: string, source?: AgentRunSource }) {
    if (source !== undefined && source !== AgentRunSource.CHAT) return configuredAgentHandlers(log)
    if (source === AgentRunSource.CHAT || !conversationId || await sydCopilotContext.conversationRepo().existsBy({ id: conversationId })) return sydCopilotRpcHandlers(log)
    return configuredAgentHandlers(log)
}

function configuredAgentHandlers(log: FastifyBaseLogger) {
    return sydAgentRpcHandlers(log)
}
