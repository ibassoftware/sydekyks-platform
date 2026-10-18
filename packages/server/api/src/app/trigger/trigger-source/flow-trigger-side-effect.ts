import { ActivepiecesError, ErrorCode, FlowId, FlowVersionId, formatPieceError, isNil, tryCatch, tryParseFriendlyPieceError } from '@activepieces/core-utils'
import {
    TriggerBase,
    TriggerStrategy,
    WebhookRenewStrategy,
} from '@activepieces/pieces-framework'
import { ApEnvironment, EngineResponse, EngineResponseStatus, ExecuteTriggerResponse, FlowTriggerType, LATEST_JOB_DATA_SCHEMA_VERSION, ScheduleOptions, TriggerHookType, TriggerSourceScheduleType, WorkerJobType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { hostingFail } from '../../hosting/hosting-transactions'
import { projectService } from '../../project/project-service'
import { jobQueue, JobType } from '../../workers/job-queue/job-queue'
import { userInteractionWatcher } from '../../workers/user-interaction-watcher'
import { appEventRoutingService } from '../app-event-routing/app-event-routing.service'

const environment = system.getOrThrow<ApEnvironment>(AppSystemProp.ENVIRONMENT)

export const flowTriggerSideEffect = (log: FastifyBaseLogger) => {
    return {
        async enable(params: EnableFlowTriggerParams): Promise<ActiveTriggerReturn> {
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                await assertHostedManualLifecycle(params, log)
                return { scheduleOptions: undefined }
            }
            if (environment === ApEnvironment.TESTING) {
                return {
                    scheduleOptions: undefined,
                }
            }
            const { flowId, flowVersionId, projectId, simulate, pieceTrigger, isRepublish } = params

            const platformId = await projectService(log).getPlatformId(projectId)
            const engineHelperResponse = await userInteractionWatcher.submitAndWaitForResponse<EngineResponse<ExecuteTriggerResponse<TriggerHookType.ON_ENABLE>>>({
                jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
                hookType: TriggerHookType.ON_ENABLE,
                flowId,
                flowVersionId,
                platformId,
                projectId,
                test: simulate,
                isRepublish,
            }, log)

            assertEngineResponseIsOk(engineHelperResponse, flowId, flowVersionId)
            if (isNil(engineHelperResponse.response)) {
                throwTriggerUpdateFailed({ flowId, flowVersionId, standardError: 'The worker skipped the trigger enable hook' })
            }

            switch (pieceTrigger.type) {
                case TriggerStrategy.APP_WEBHOOK: {
                    return handleAppWebhookTrigger({
                        engineHelperResponse,
                        log,
                        ...params,
                    })
                }
                case TriggerStrategy.WEBHOOK: {
                    return handleWebhookTrigger({
                        engineHelperResponse,
                        log,
                        ...params,
                    })
                }
                case TriggerStrategy.POLLING: {
                    return handlePollingTrigger({
                        engineHelperResponse,
                        log,
                        ...params,
                    })
                }
                case TriggerStrategy.MANUAL: {
                    return {
                        scheduleOptions: undefined,
                    }
                }
            }
        },
        async disable(params: DisableFlowTriggerParams): Promise<void> {
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                await assertHostedManualLifecycle(params, log)
                return
            }
            if (environment === ApEnvironment.TESTING) {
                return
            }
            const { flowId, flowVersionId, projectId, simulate, pieceTrigger } = params
            const platformId = await projectService(log).getPlatformId(projectId)
            const { error, data: engineHelperResponse } = await tryCatch(
                () => userInteractionWatcher.submitAndWaitForResponse<EngineResponse<ExecuteTriggerResponse<TriggerHookType.ON_DISABLE>>>({
                    jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
                    hookType: TriggerHookType.ON_DISABLE,
                    flowId,
                    flowVersionId,
                    test: simulate,
                    projectId,
                    platformId,
                }, log),
            )
            if (!isNil(error)) {
                if (!params.ignoreError) {
                    throw error
                }
                log.warn({ flow: { id: flowId }, error: error.message }, IGNORED_DISABLE_ERROR)
            }
            else if (!params.ignoreError) {
                assertEngineResponseIsOk(engineHelperResponse!, flowId, flowVersionId)
            }
            else if (engineHelperResponse?.status !== EngineResponseStatus.OK) {
                log.warn({ flow: { id: flowId }, error: sanitizeIgnoredError(engineHelperResponse?.error) }, IGNORED_DISABLE_ERROR)
            }
            switch (pieceTrigger.type) {
                case TriggerStrategy.APP_WEBHOOK:
                    await appEventRoutingService.deleteListeners({
                        projectId,
                        flowId,
                    })
                    break
                case TriggerStrategy.WEBHOOK: {
                    const renewConfiguration = pieceTrigger.renewConfiguration
                    if (renewConfiguration?.strategy === WebhookRenewStrategy.CRON) {
                        await jobQueue(log).removeRepeatingJob({
                            flowVersionId,
                        })
                    }
                    break
                }
                case TriggerStrategy.POLLING:
                    await jobQueue(log).removeRepeatingJob({
                        flowVersionId,
                    })
                    break
                case TriggerStrategy.MANUAL:
                    break
            }
        },

    }
}

function sanitizeIgnoredError(error: string | undefined): string {
    return tryParseFriendlyPieceError(error)?.message ?? formatPieceError(error).message
}

async function handleAppWebhookTrigger({ engineHelperResponse, flowId, projectId, pieceName }: ActiveTriggerParams): Promise<ActiveTriggerReturn> {
    for (const listener of engineHelperResponse.response?.listeners ?? []) {
        await appEventRoutingService.createListeners({
            projectId,
            flowId,
            appName: pieceName,
            events: listener.events,
            identifierValue: listener.identifierValue,
        })
    }
    return {
        scheduleOptions: undefined,
    }
}

async function handleWebhookTrigger({ flowId, flowVersionId, projectId, pieceTrigger, log }: ActiveTriggerParams): Promise<ActiveTriggerReturn> {
    const renewConfiguration = pieceTrigger.renewConfiguration
    switch (renewConfiguration?.strategy) {
        case WebhookRenewStrategy.CRON: {
            const platformId = await projectService(log).getPlatformId(projectId)
            await jobQueue(log).add({
                id: flowVersionId,
                type: JobType.REPEATING,
                data: {
                    schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                    projectId,
                    flowVersionId,
                    flowId,
                    jobType: WorkerJobType.RENEW_WEBHOOK,
                    platformId,
                },
                scheduleOptions: {
                    type: TriggerSourceScheduleType.CRON_EXPRESSION,
                    cronExpression: renewConfiguration.cronExpression,
                    timezone: 'UTC',
                },
            })
            break
        }
        default:
            break
    }
    return {
        scheduleOptions: undefined,
    }
}

async function handlePollingTrigger({ engineHelperResponse, flowId, flowVersionId, projectId, log }: ActiveTriggerParams): Promise<ActiveTriggerReturn> {
    const pollIntervalMinutes = system.getNumberOrThrow(AppSystemProp.TRIGGER_DEFAULT_POLL_INTERVAL)
    const defaultScheduleOptions: ScheduleOptions = {
        type: TriggerSourceScheduleType.INTERVAL,
        intervalMs: pollIntervalMinutes * 60_000,
    }
    const scheduleOptions = engineHelperResponse.response?.scheduleOptions ?? defaultScheduleOptions
    const platformId = await projectService(log).getPlatformId(projectId)
    await jobQueue(log).add({
        id: flowVersionId,
        type: JobType.REPEATING,
        data: {
            schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
            projectId,
            flowVersionId,
            flowId,
            triggerType: FlowTriggerType.PIECE,
            jobType: WorkerJobType.EXECUTE_POLLING,
            platformId,
        },
        scheduleOptions,
    })
    return {
        scheduleOptions,
    }
}

// The reviewed built-in manual trigger has empty enable/disable hooks.
// Model its registration directly instead of admitting an unmetered hook job.
// Every other trigger still needs the future metered trigger coordinator.
async function assertHostedManualLifecycle(params: EnableFlowTriggerParams, log: FastifyBaseLogger): Promise<void> {
    const version = await flowVersionService(log).getOneOrThrow(params.flowVersionId)
    if (version.flowId !== params.flowId || version.trigger.type !== FlowTriggerType.PIECE || params.simulate || params.pieceName !== '@activepieces/piece-manual-trigger' || params.pieceTrigger.type !== TriggerStrategy.MANUAL || params.pieceTrigger.name !== 'manual_trigger' || version.trigger.settings.pieceName !== params.pieceName || version.trigger.settings.pieceVersion !== '0.0.8' || version.trigger.settings.triggerName !== params.pieceTrigger.name) hostingFail('HOSTING_TRIGGER_COORDINATOR_REQUIRED')
}

const IGNORED_DISABLE_ERROR = '[flowTriggerSideEffect#disable] Ignored error during trigger disable'

function assertEngineResponseIsOk(engineHelperResponse: EngineResponse<ExecuteTriggerResponse<TriggerHookType.ON_ENABLE | TriggerHookType.ON_DISABLE>>, flowId: FlowId, flowVersionId: FlowVersionId) {
    if (isNil(engineHelperResponse) || engineHelperResponse.status !== EngineResponseStatus.OK) {
        throwTriggerUpdateFailed({ flowId, flowVersionId, standardError: engineHelperResponse?.error ?? 'Engine response is undefined' })
    }
}

function throwTriggerUpdateFailed({ flowId, flowVersionId, standardError }: ThrowTriggerUpdateFailedParams): never {
    throw new ActivepiecesError({
        code: ErrorCode.TRIGGER_UPDATE_STATUS,
        params: {
            flowId,
            flowVersionId,
            standardOutput: '',
            standardError,
        },
    }, `flowId=${flowId} standardError=${standardError}`)
}


type EnableFlowTriggerParams = {
    flowId: FlowId
    flowVersionId: FlowVersionId
    pieceName: string
    projectId: string
    pieceTrigger: TriggerBase
    simulate: boolean
    isRepublish?: boolean
}

type DisableFlowTriggerParams = EnableFlowTriggerParams & {
    ignoreError: boolean
}

type ActiveTriggerParams = EnableFlowTriggerParams & {
    log: FastifyBaseLogger
    engineHelperResponse: EngineResponse<ExecuteTriggerResponse<TriggerHookType.ON_ENABLE>>
}

type ActiveTriggerReturn = {
    scheduleOptions?: ScheduleOptions
}

type ThrowTriggerUpdateFailedParams = {
    flowId: FlowId
    flowVersionId: FlowVersionId
    standardError: string
}
