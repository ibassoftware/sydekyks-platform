import { createHash } from 'node:crypto'
import { isNil, isObject } from '@activepieces/core-utils'
import { ActionContext, backwardCompatabilityContextUtils, CreateWaitpointHook, CreateWaitpointParams, CreateWaitpointResult, InputPropertyMap, PieceAuthProperty, PiecePropertyMap, RespondHook, RespondHookParams, StaticPropsValue, StopHook, StopHookParams, TagsManager, WaitForWaitpointHook } from '@activepieces/pieces-framework'
import { AUTHENTICATION_PROPERTY_NAME, EngineGenericError, ExecutionType, FlowActionType, FlowRunStatus, GenericStepOutput, PausedFlowTimeoutError, PieceAction, RespondResponse, StepOutputStatus } from '@activepieces/shared'
import dayjs from 'dayjs'
import { engineRunApi } from '../api/engine-run-api'
import { continueIfFailureHandler, runWithExponentialBackoff } from '../helper/error-handling'
import { flowRunProgressReporter } from '../helper/flow-run-progress-reporter'
import { pieceLoader } from '../helper/piece-loader'
import { createFileUploader } from '../piece-context/file-uploader'
import { createFlowsContext } from '../piece-context/flows'
import { prepareLegacyTodo } from '../piece-context/legacy-todo'
import { createContextStore } from '../piece-context/store'
import { waitpointClient } from '../piece-context/waitpoint-client'
import { HookResponse, utils } from '../utils'
import { propsProcessor } from '../variables/props-processor'
import { ActionHandler, BaseExecutor, failStep } from './base-executor'
import { EngineConstants } from './context/engine-constants'

const AP_PAUSED_FLOW_TIMEOUT_DAYS = Number(process.env.AP_PAUSED_FLOW_TIMEOUT_DAYS)

export const pieceExecutor: BaseExecutor<PieceAction> = {
    async handle({
        action,
        executionState,
        constants,
    }) {
        if (executionState.isCompleted({ stepName: action.name })) {
            return executionState
        }
        // A hosted AI denial must stop the run. Each actual AI call needs its
        // own admission; generic piece retries/continue cannot bypass that gate.
        const admittedAction = constants.hostedAccounting && action.settings.pieceName === '@activepieces/piece-ai'
            ? { ...action, settings: { ...action.settings, errorHandlingOptions: { ...action.settings.errorHandlingOptions, retryOnFailure: { value: false }, continueOnFailure: { value: false } } } }
            : action
        const resultExecution = await runWithExponentialBackoff(executionState, admittedAction, constants, executeAction)
        return continueIfFailureHandler(resultExecution, admittedAction, constants)
    },
}

const executeAction: ActionHandler<PieceAction> = async ({ action, executionState, constants }) => {
    const stepStartTime = performance.now()
    const stepOutput = GenericStepOutput.create({
        input: {},
        type: FlowActionType.PIECE,
        status: StepOutputStatus.RUNNING,
    })

    const { data: executionStateResult, error: executionStateError } = await utils.tryCatchAndThrowOnEngineError((async () => {
        if (isNil(action.settings.actionName)) {
            throw new EngineGenericError('ActionNameNotSetError', 'Action name is not set')
        }

        const { pieceAction, piece } = await pieceLoader.getPieceAndActionOrThrow({
            pieceName: action.settings.pieceName,
            pieceVersion: action.settings.pieceVersion,
            actionName: action.settings.actionName,
            devPieces: constants.devPieces,
        })

        const { resolvedInput, censoredInput } = await constants.getPropsResolver({ contextVersion: piece.getContextInfo?.().version, pieceName: action.settings.pieceName }).resolve<StaticPropsValue<PiecePropertyMap>>({
            unresolvedInput: action.settings.input,
            executionState,
        })

        stepOutput.input = censoredInput

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, pieceAction.props, piece.auth, pieceAction.requireAuth, action.settings.propertySettings, constants.hostedAccounting ? { engineToken: constants.engineToken, internalApiUrl: constants.internalApiUrl, publicApiUrl: constants.publicApiUrl } : undefined)
        if (Object.keys(errors).length > 0) {
            throw new Error(JSON.stringify(errors, null, 2))
        }


        const params: {
            hookResponse: HookResponse
        } = {
            hookResponse: {
                type: 'none',
                tags: [],
            },
        }
        const outputContext = constants.actionRunMode
            ? { update: async (): Promise<void> => { /* no-op: action runs have no live progress channel */ } }
            : flowRunProgressReporter.createOutputContext({
                engineConstants: constants,
            })

        const isPaused = executionState.isPaused({ stepName: action.name })
        if (!isPaused) {
            await flowRunProgressReporter.sendUpdate({
                engineConstants: constants,
                flowExecutorContext: await executionState.upsertStep(action.name, stepOutput),
                stepNameToUpdate: action.name,
            })
        }
        const context: ActionContext<PieceAuthProperty, InputPropertyMap> = {
            executionType: isPaused ? ExecutionType.RESUME : ExecutionType.BEGIN,
            resumePayload: constants.resumePayload!,
            store: createContextStore({
                apiUrl: constants.internalApiUrl,
                prefix: '',
                flowId: constants.flowId,
                engineToken: constants.engineToken,
            }),
            output: outputContext,
            flows: createFlowsContext({
                engineToken: constants.engineToken,
                internalApiUrl: constants.internalApiUrl,
                flowId: constants.flowId,
                flowVersionId: constants.flowVersionId,
            }),
            step: {
                name: action.name,
            },
            auth: processedInput[AUTHENTICATION_PROPERTY_NAME],
            files: createFileUploader({
                apiUrl: constants.internalApiUrl,
                engineToken: constants.engineToken,
            }),
            server: {
                token: constants.engineToken,
                apiUrl: constants.internalApiUrl,
                publicUrl: constants.publicApiUrl,
            },
            propsValue: processedInput,
            tags: createTagsManager(params),
            connections: utils.createConnectionManager({
                apiUrl: constants.internalApiUrl,
                projectId: constants.projectId,
                engineToken: constants.engineToken,
                target: 'actions',
                hookResponse: params.hookResponse,
                contextVersion: piece.getContextInfo?.().version,
                pieceName: action.settings.pieceName,
            }),
            run: {
                id: constants.flowRunId,
                ...(constants.hostedAccounting ? { callAi: async (request: Record<string, unknown>) => {
                    const callKey = createHash('sha256').update(executionState.currentPath.waitpointKeyFor({ stepName: action.name })).digest('hex')
                    const response = await fetch(`${constants.internalApiUrl}v1/engine/hosting-ai/step`, { method: 'POST', headers: { Authorization: `Bearer ${constants.engineToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, callKey, stepName: action.name }) })
                    if (!response.ok) {
                        const body: unknown = await response.json().catch(() => null)
                        const refusal = hostedAiRefusalMessage(response.status, body)
                        // Only verified, allowlisted unsent gateway refusals are
                        // ordinary FAILED steps. Unknown outcomes retain the
                        // existing engine-uncertainty accounting path.
                        if (refusal) throw new Error(refusal)
                        throw new EngineGenericError('HostedAiDenied', `AI request failed (${response.status})`)
                    }
                    return response.json()
                }, callSubflow: async (params: { flowId: string, data: unknown, callbackUrl?: string, failParentOnFailure: boolean, key?: string }) => {
                    const key = createHash('sha256').update(JSON.stringify([executionState.currentPath.waitpointKeyFor({ stepName: action.name }), params.key ?? 'call'])).digest('hex')
                    const response = await fetch(`${constants.internalApiUrl}v1/engine/nested-runs`, { method: 'POST', headers: { Authorization: `Bearer ${constants.engineToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, key }) })
                    if (!response.ok) throw new EngineGenericError('HostedNestedDispatchDenied', `Nested run request failed (${response.status})`)
                    return response.json()
                } } : {}),
                canPause: !constants.actionRunMode,
                stop: createStopHook(params),
                respond: createRespondHook(params),
                createWaitpoint: createWaitpointHook({ constants, waitpointKey: executionState.currentPath.waitpointKeyFor({ stepName: action.name }), hookParams: params }),
                waitForWaitpoint: createWaitForWaitpointHook({ constants, hookParams: params }),
            },
            project: {
                id: constants.projectId,
                externalId: constants.externalProjectId,
            },
        }
        const backwardCompatibleContext = backwardCompatabilityContextUtils.makeActionContextBackwardCompatible({
            contextVersion: piece.getContextInfo?.().version,
            context,
        })
        const testSingleStepMode = !isNil(constants.stepNameToTest)
        const runMethodToExecute = (testSingleStepMode && !isNil(pieceAction.test)) ? pieceAction.test : pieceAction.run
        const todoBridge = constants.hostedAccounting ? await prepareLegacyTodo({
            context: backwardCompatibleContext,
            pieceName: action.settings.pieceName,
            actionName: action.settings.actionName,
            waitpointKey: executionState.currentPath.waitpointKeyFor({ stepName: action.name }),
            isSingleStepTest: testSingleStepMode,
            createTodoWaitpoint: createWaitpointHook({ constants, waitpointKey: `__catalogue_todo__/${executionState.currentPath.waitpointKeyFor({ stepName: action.name })}`, hookParams: params }),
        }) : { context: backwardCompatibleContext, complete: async (_output: unknown): Promise<void> => undefined }
        const output = await runMethodToExecute(todoBridge.context)
        await todoBridge.complete(output)
        const newExecutionContext = executionState.addTags(params.hookResponse.tags)

        const webhookResponse = getResponse(params.hookResponse)
        const isSamePiece = constants.triggerPieceName === action.settings.pieceName
        if (!isNil(webhookResponse) && !isNil(constants.workerHandlerId) && !isNil(constants.httpRequestId) && isSamePiece) {
            await engineRunApi.sendFlowResponse({
                apiUrl: constants.internalApiUrl,
                engineToken: constants.engineToken,
                request: {
                    workerHandlerId: constants.workerHandlerId,
                    httpRequestId: constants.httpRequestId,
                    runResponse: {
                        status: webhookResponse.status ?? 200,
                        body: webhookResponse.body ?? {},
                        headers: isObject(webhookResponse.headers) ? webhookResponse.headers : {},
                    },
                },
            })
        }

        const stepEndTime = performance.now()
        if (params.hookResponse.type === 'stopped') {
            if (isNil(params.hookResponse.response)) {
                throw new EngineGenericError('StopResponseNotSetError', 'Stop response is not set')
            }
            const succeeded = stepOutput.setOutput(output).setStatus(StepOutputStatus.SUCCEEDED).setDuration(stepEndTime - stepStartTime)
            return (await newExecutionContext.upsertStep(action.name, succeeded)).incrementStepsExecuted().setVerdict({
                status: FlowRunStatus.SUCCEEDED,
                stopResponse: (params.hookResponse.response as StopHookParams).response,
            })
        }
        if (params.hookResponse.type === 'paused') {
            const paused = stepOutput.setOutput(output).setStatus(StepOutputStatus.PAUSED).setDuration(stepEndTime - stepStartTime)
            return (await newExecutionContext.upsertStep(action.name, paused))
                .incrementStepsExecuted()
                .setVerdict({ status: FlowRunStatus.PAUSED, waitpointId: params.hookResponse.waitpointId })
        }
        const succeeded = stepOutput.setOutput(output).setStatus(StepOutputStatus.SUCCEEDED).setDuration(stepEndTime - stepStartTime)
        return (await newExecutionContext.upsertStep(action.name, succeeded)).incrementStepsExecuted().setVerdict({ status: FlowRunStatus.RUNNING })

    }))

    if (executionStateError) {
        return failStep({
            action,
            executionState,
            stepOutput,
            error: executionStateError,
            durationMs: performance.now() - stepStartTime,
        })
    }

    return executionStateResult
}

function getResponse(hookResponse: HookResponse): RespondResponse | undefined {
    switch (hookResponse.type) {
        case 'stopped':
        case 'respond':
            return hookResponse.response.response
        case 'paused':
            return hookResponse.responseToSend
        case 'none':
            return undefined
    }
}

const createTagsManager = (hkParams: createTagsManagerParams): TagsManager => {
    return {
        add: async (params: addTagsParams): Promise<void> => {
            hkParams.hookResponse.tags.push(params.name)
        },

    }
}

type addTagsParams = {
    name: string
}

type createTagsManagerParams = {
    hookResponse: HookResponse
}


function createStopHook(params: CreateStopHookParams): StopHook {
    return (req?: StopHookParams) => {
        params.hookResponse = {
            ...params.hookResponse,
            type: 'stopped',
            response: req ?? { response: {} },
        }
    }
}
type CreateStopHookParams = {
    hookResponse: HookResponse
}

function createRespondHook(params: CreateRespondHookParams): RespondHook {
    return (req?: RespondHookParams) => {
        params.hookResponse = {
            ...params.hookResponse,
            type: 'respond',
            response: req ?? { response: {} },
        }
    }
}

type CreateRespondHookParams = {
    hookResponse: HookResponse
}

function createWaitpointHook({ constants, waitpointKey, hookParams }: { constants: EngineConstants, waitpointKey: string, hookParams: { hookResponse: HookResponse } }): CreateWaitpointHook {
    return (req: CreateWaitpointParams): Promise<CreateWaitpointResult> => {
        assertActionRunCannotSuspend(constants)
        return submitWaitpoint({ constants, waitpointKey, hookParams, req })
    }
}

async function submitWaitpoint({ constants, waitpointKey, hookParams, req }: { constants: EngineConstants, waitpointKey: string, hookParams: { hookResponse: HookResponse }, req: CreateWaitpointParams }): Promise<CreateWaitpointResult> {
    const resumeDateTime = cappedForTestFlow({ resumeDateTime: req.resumeDateTime, maxTestWaitMs: req.maxTestWaitMs, isTestFlow: constants.isTestFlow })
    assertDelayWithinTimeout(resumeDateTime)
    if (!isNil(req.responseToSend)) {
        hookParams.hookResponse = { ...hookParams.hookResponse, responseToSend: req.responseToSend }
    }
    const result = await waitpointClient.create({
        apiUrl: constants.internalApiUrl,
        engineToken: constants.engineToken,
        flowRunId: constants.flowRunId,
        projectId: constants.projectId,
        stepName: waitpointKey,
        type: req.type,
        version: req.version ?? 'V1',
        resumeDateTime,
        responseToSend: req.responseToSend,
        workerHandlerId: constants.workerHandlerId ?? undefined,
        httpRequestId: constants.httpRequestId ?? undefined,
    })
    return {
        ...result,
        buildResumeUrl: (params: { queryParams: Record<string, string>, sync?: boolean }): string => {
            const url = new URL(`${result.resumeUrl}${params.sync ? '/sync' : ''}`)
            url.search = new URLSearchParams(params.queryParams).toString()
            return url.toString()
        },
    }
}

function createWaitForWaitpointHook({ constants, hookParams }: { constants: EngineConstants, hookParams: { hookResponse: HookResponse } }): WaitForWaitpointHook {
    return (waitpointId: string) => {
        assertActionRunCannotSuspend(constants)
        hookParams.hookResponse = {
            ...hookParams.hookResponse,
            type: 'paused',
            waitpointId,
        }
    }
}

function assertActionRunCannotSuspend(constants: EngineConstants): void {
    if (constants.actionRunMode) {
        throw new Error('This action pauses the run (waitpoint) and can only run inside a flow, not as a action run.')
    }
}

function cappedForTestFlow({ resumeDateTime, maxTestWaitMs, isTestFlow }: { resumeDateTime?: string, maxTestWaitMs?: number, isTestFlow: boolean }): string | undefined {
    const noShorterTestWaitAsked = isNil(resumeDateTime) || isNil(maxTestWaitMs) || !isTestFlow
    if (noShorterTestWaitAsked) {
        return resumeDateTime
    }
    const ceiling = dayjs().add(maxTestWaitMs, 'millisecond')
    return dayjs(resumeDateTime).isAfter(ceiling) ? ceiling.toISOString() : resumeDateTime
}

function assertDelayWithinTimeout(resumeDateTime?: string): void {
    if (isNil(resumeDateTime)) {
        return
    }
    const diffInDays = dayjs(resumeDateTime).diff(dayjs(), 'days')
    if (diffInDays > AP_PAUSED_FLOW_TIMEOUT_DAYS) {
        throw new PausedFlowTimeoutError(undefined, AP_PAUSED_FLOW_TIMEOUT_DAYS)
    }
}

export function hostedAiRefusalMessage(status: number, body: unknown): string | null {
    if (status !== 403 || !body || typeof body !== 'object' || !('code' in body)) return null
    switch (body.code) {
        case 'HOSTING_CREDITS_EXHAUSTED':
            return 'Not enough Credits are available for this AI step. Check billing or contact your workspace administrator.'
        case 'HOSTING_RUN_CREDIT_LIMIT':
        case 'HOSTING_AI_CALL_LIMIT':
        case 'HOSTING_NATIVE_TOOL_LIMIT':
        case 'HOSTING_NATIVE_CREDIT_LIMIT':
        case 'HOSTING_NATIVE_OUTPUT_LIMIT':
        case 'HOSTING_AI_REQUEST_LIMIT':
            return 'This Mission reached its AI safety limit. Reduce its AI workload or contact your workspace administrator.'
        case 'HOSTING_AI_CAPABILITY_DENIED':
        case 'HOSTING_NATIVE_FEATURE_DENIED':
            return 'This AI feature is not enabled for this Mission. Ask your workspace administrator to review its settings.'
        case 'HOSTING_NATIVE_URL_DENIED':
            return 'This page cannot be opened. Choose a public HTTPS page.'
        case 'HOSTING_NATIVE_PRICING_APPROVAL_REQUIRED':
            return 'Web search is awaiting administrator approval. Ask your workspace administrator to review its settings.'
        case 'HOSTING_AI_STEP_DENIED':
            return 'This AI step no longer matches the saved Mission. Refresh its configuration before running again.'
        case 'HOSTING_AI_FILE_CHANGED':
        case 'HOSTING_AI_FILE_INVALID':
        case 'HOSTING_AI_FILE_SCOPE_DENIED':
        case 'HOSTING_AI_FILE_UNAVAILABLE':
            return 'An attachment is no longer available. Upload it again before running this Mission.'
        case 'HOSTING_OPERATOR_BUDGET_EXHAUSTED':
            return 'Sydekyks AI is temporarily unavailable. Contact your workspace administrator before trying again.'
        case 'HOSTING_BYOK_SCOPE_DENIED':
        case 'HOSTING_EXACT_BYOK_KEY_REQUIRED':
            return 'The selected client AI key is unavailable for this Mission. Ask your workspace administrator to update its AI connection, then try again.'
        default:
            return null
    }
}
