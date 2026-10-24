import { FlowRunStatus, FlowStatus, RunEnvironment } from '@activepieces/shared'
import { StatusCodes } from 'http-status-codes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookFlowVersionToRun } from '../../../../src/app/webhooks/webhook.service'

const { mockShouldBlockRunOnCredits, mockStart, mockCreateQuotaExceededRun, mockFindOneBy, mockOneTimeListener, mockQueueAdd, mockData, mockPayloadSize, mode } = vi.hoisted(() => ({
    mockShouldBlockRunOnCredits: vi.fn(),
    mockStart: vi.fn(),
    mockCreateQuotaExceededRun: vi.fn(),
    mockFindOneBy: vi.fn(),
    mockOneTimeListener: vi.fn(),
    mockQueueAdd: vi.fn(), mockData: vi.fn(), mockPayloadSize: vi.fn(),
    mode: { value: 'self_hosted', flowStatus: 'ENABLED' },
}))

vi.mock('@activepieces/server-utils', async importOriginal => ({
    ...await importOriginal<typeof import('@activepieces/server-utils')>(),
    wideEvent: { set: vi.fn(), error: vi.fn(), timed: async ({ fn }: { fn: () => Promise<unknown> }) => fn() },
}))

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        getNumberOrThrow: vi.fn().mockReturnValue(30),
        get: vi.fn(),
        getBoolean: vi.fn().mockReturnValue(false),
        getEdition: vi.fn().mockReturnValue('cloud'),
    },
}))

vi.mock('../../../../src/app/hosting/hosting-configuration', () => ({ hostingConfiguration: { getServiceMode: () => mode.value } }))

vi.mock('../../../../src/app/platform/billing-provider', () => ({
    shouldBlockRunOnCredits: mockShouldBlockRunOnCredits,
}))

vi.mock('../../../../src/app/flows/flow-run/flow-run-service', () => ({
    flowRunService: () => ({
        start: mockStart,
        createQuotaExceededRun: mockCreateQuotaExceededRun,
    }),
}))

vi.mock('../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionRepo: () => ({ findOneBy: mockFindOneBy, createQueryBuilder: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ getRawOne: async () => ({ id: 'ver-draft' }) }) }) }) }) }),
}))

vi.mock('../../../../src/app/flows/flow/flow-execution-cache', () => ({
    flowExecutionCache: () => ({
        get: vi.fn().mockResolvedValue({
            exists: true,
            platformId: 'plat-1',
            handshakeConfiguration: undefined,
            flow: {
                id: 'flow-1',
                projectId: 'proj-1',
                status: mode.flowStatus,
                publishedVersionId: 'ver-1',
            },
        }),
    }),
}))

vi.mock('../../../../src/app/workers/engine-response-watcher', () => ({
    engineResponseWatcher: () => ({
        getServerId: vi.fn().mockReturnValue('worker-1'),
        oneTimeListener: mockOneTimeListener,
    }),
}))

vi.mock('../../../../src/app/workers/payload-offloader', () => ({
    payloadOffloader: { getPayloadSizeInBytes: mockPayloadSize, offloadPayload: async (_log: unknown, payload: unknown) => payload },
}))

vi.mock('../../../../src/app/helper/logger', () => ({
    pinoLogging: {
        createWebhookContextLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}))

vi.mock('../../../../src/app/helper/promise-handler', () => ({
    rejectedPromiseHandler: vi.fn(),
}))

vi.mock('../../../../src/app/trigger/trigger-source/trigger-source-service', () => ({
    triggerSourceService: () => ({ disable: vi.fn() }),
}))

vi.mock('../../../../src/app/workers/job-queue/job-queue', () => ({
    jobQueue: () => ({ add: mockQueueAdd }),
    JobType: { ONE_TIME: 'ONE_TIME' },
}))

vi.mock('../../../../src/app/webhooks/webhook-handshake', () => ({
    webhookHandshake: { handleHandshakeRequest: vi.fn().mockResolvedValue(null) },
}))

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

async function callSyncWebhook() {
    const { webhookService } = await import('../../../../src/app/webhooks/webhook.service')
    return webhookService.handleWebhook({
        logger: noopLogger as never,
        data: vi.fn(),
        flowId: 'flow-1',
        async: false,
        saveSampleData: false,
        flowVersionToRun: WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
        payload: { body: {}, headers: {}, queryParams: {}, method: 'POST' },
        execute: true,
        onRunCreated: undefined,
        parentRunId: undefined,
        failParentOnFailure: false,
        timeoutMs: undefined,
    } as never)
}

describe('sync webhook credit gate', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mode.value = 'self_hosted'; mode.flowStatus = FlowStatus.ENABLED
        mockPayloadSize.mockReturnValue(128)
        mockFindOneBy.mockResolvedValue({ id: 'ver-1', flowId: 'flow-1' })
        mockCreateQuotaExceededRun.mockResolvedValue({ id: 'run-quota' })
        mockStart.mockResolvedValue({ id: 'run-1' })
        mockOneTimeListener.mockResolvedValue({ status: StatusCodes.OK, body: { ok: true }, headers: {} })
    })

    it('answers 402 instead of running the flow when the platform is out of credits', async () => {
        mockShouldBlockRunOnCredits.mockResolvedValue(true)

        const response = await callSyncWebhook()

        expect(response.status).toBe(StatusCodes.PAYMENT_REQUIRED)
        expect(mockStart).not.toHaveBeenCalled()
    })

    it('still persists the trigger payload as a retryable run when out of credits', async () => {
        mockShouldBlockRunOnCredits.mockResolvedValue(true)

        await callSyncWebhook()

        expect(mockCreateQuotaExceededRun).toHaveBeenCalledTimes(1)
        expect(mockCreateQuotaExceededRun.mock.calls[0][0]).toMatchObject({
            projectId: 'proj-1',
            environment: RunEnvironment.PRODUCTION,
            shouldExecuteTriggerOnRetry: true,
        })
        expect(mockCreateQuotaExceededRun.mock.calls[0][0].payload).toBeDefined()
    })

    it('runs the flow and returns the engine response when the gate lets it through', async () => {
        mockShouldBlockRunOnCredits.mockResolvedValue(false)

        const response = await callSyncWebhook()

        expect(mockStart).toHaveBeenCalledTimes(1)
        expect(mockCreateQuotaExceededRun).not.toHaveBeenCalled()
        expect(response.status).toBe(StatusCodes.OK)
        expect(response.body).toEqual({ ok: true })
    })

    it('checks the gate against the platform and the production environment', async () => {
        mockShouldBlockRunOnCredits.mockResolvedValue(false)

        await callSyncWebhook()

        expect(mockShouldBlockRunOnCredits.mock.calls[0][0]).toMatchObject({
            platformId: 'plat-1',
            environment: RunEnvironment.PRODUCTION,
        })
    })
})


const draftActor = { userId: 'user-1', tokenVersion: 'current-version', projectId: 'proj-1', platformId: 'plat-1' }
async function callDraft({ async = false, actor = draftActor }: { async?: boolean, actor?: typeof draftActor | null } = {}) {
    const { webhookService } = await import('../../../../src/app/webhooks/webhook.service')
    return webhookService.handleWebhook({ logger: noopLogger as never, data: mockData, flowId: 'flow-1', async, saveSampleData: true, flowVersionToRun: WebhookFlowVersionToRun.LATEST, payload: { body: { resumeText: 'sample' }, headers: {}, queryParams: {}, method: 'POST' }, execute: true, failParentOnFailure: false, ...(actor ? { hostedDraftActor: actor } : {}) })
}

describe('authenticated hosted draft webhook execution', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mode.value = 'hosted'; mode.flowStatus = FlowStatus.DISABLED
        mockPayloadSize.mockReturnValue(128)
        mockShouldBlockRunOnCredits.mockResolvedValue(false)
        mockStart.mockResolvedValue({ id: 'run-draft', status: FlowRunStatus.QUEUED })
        mockOneTimeListener.mockResolvedValue({ status: 200, body: { type: 'markdown', value: 'finished' }, headers: {} })
        mockFindOneBy.mockResolvedValue({ id: 'ver-draft', flowId: 'flow-1' })
        mockCreateQuotaExceededRun.mockResolvedValue({ id: 'refused-run' })
    })
    it('starts one ordinary TESTING flow root with the verified actor and waits for its response', async () => {
        const response = await callDraft()
        expect(response.status).toBe(200)
        expect(mockStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostedOrigin: { type: 'user', userId: 'user-1', tokenVersion: 'current-version' }, platformId: 'plat-1', projectId: 'proj-1', flowId: 'flow-1', flowVersionId: 'ver-draft', environment: RunEnvironment.TESTING, executeTrigger: true, streamStepProgress: 'WEBSOCKET', workerHandlerId: 'worker-1' }))
        expect(mockQueueAdd).not.toHaveBeenCalled() // No parallel capture/execution coordinator.
        expect(mockOneTimeListener).toHaveBeenCalledOnce()
    })
    it('queues an asynchronous draft once without a response watcher or sample job', async () => {
        const response = await callDraft({ async: true })
        expect(response.body).toEqual({ runId: 'run-draft', environment: RunEnvironment.TESTING })
        expect(mockStart).toHaveBeenCalledOnce()
        expect(mockStart.mock.calls[0][0]).toMatchObject({ workerHandlerId: undefined, httpRequestId: undefined })
        expect(mockQueueAdd).not.toHaveBeenCalled()
        expect(mockOneTimeListener).not.toHaveBeenCalled()
    })
    it('denies absent actor and mismatched project/platform before any run or queue write', async () => {
        for (const actor of [null, { ...draftActor, projectId: 'foreign' }, { ...draftActor, platformId: 'foreign' }]) await expect(callDraft({ actor })).rejects.toThrow(/HOSTING_(AUTHENTICATED_DRAFT_REQUIRED|PROJECT_ACCESS_DENIED)/)
        expect(mockStart).not.toHaveBeenCalled()
        expect(mockQueueAdd).not.toHaveBeenCalled()
        expect(mockData).not.toHaveBeenCalled()
    })
    it('keeps payload bounds before dispatch', async () => {
        mockPayloadSize.mockReturnValue(Number.MAX_SAFE_INTEGER)
        expect((await callDraft()).status).toBe(413)
        expect(mockStart).not.toHaveBeenCalled()
        expect(mockQueueAdd).not.toHaveBeenCalled()
    })
    it('does not dispatch when the existing Credit gate refuses', async () => {
        mockShouldBlockRunOnCredits.mockResolvedValue(true)
        expect((await callDraft()).status).toBe(402)
        expect(mockStart).not.toHaveBeenCalled()
        expect(mockQueueAdd).not.toHaveBeenCalled()
        expect(mockCreateQuotaExceededRun).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: 'user-1', environment: RunEnvironment.TESTING }))
    })
    it('returns a definitive admission refusal without waiting or automatically trying again', async () => {
        mockStart.mockResolvedValue({ id: 'refused-run', status: FlowRunStatus.FAILED, finishTime: new Date().toISOString() })
        expect((await callDraft()).status).toBe(402)
        expect(mockStart).toHaveBeenCalledOnce()
        expect(mockQueueAdd).not.toHaveBeenCalled()
        expect(mockOneTimeListener).not.toHaveBeenCalled()
    })
    it('preserves the existing self-hosted asynchronous draft path', async () => {
        mode.value = 'self_hosted'; mode.flowStatus = FlowStatus.ENABLED
        expect((await callDraft({ async: true, actor: null })).status).toBe(200)
        expect(mockStart).not.toHaveBeenCalled()
        expect(mockQueueAdd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostedOrigin: { type: 'scheduled' }, data: expect.objectContaining({ execute: true, saveSampleData: true, runEnvironment: RunEnvironment.TESTING }) }))
    })
})
