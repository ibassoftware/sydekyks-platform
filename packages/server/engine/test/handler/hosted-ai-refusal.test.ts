import { EngineGenericError, FlowRunStatus } from '@activepieces/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetPieceAndAction } = vi.hoisted(() => ({ mockGetPieceAndAction: vi.fn() }))
vi.mock('../../src/lib/helper/piece-loader', () => ({ pieceLoader: { getPieceAndActionOrThrow: mockGetPieceAndAction, loadPieceOrThrow: vi.fn(), getPackageAlias: vi.fn(), getPiecePath: vi.fn(), getPropOrThrow: vi.fn() } }))
vi.mock('../../src/lib/api/engine-run-api', () => ({ engineRunApi: { updateRunProgress: vi.fn(), updateStepProgress: vi.fn(), uploadRunLog: vi.fn(), sendFlowResponse: vi.fn() } }))

import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { hostedAiRefusalMessage, pieceExecutor } from '../../src/lib/handler/piece-executor'
import { buildPieceAction, generateMockEngineConstants } from './test-helper'

const token = `synthetic.${Buffer.from(JSON.stringify({ hostingProtocol: 1 })).toString('base64url')}.signature`
const action = () => buildPieceAction({ name: 'ai', pieceName: '@activepieces/piece-ai', actionName: 'askAi', input: {}, errorHandlingOptions: { retryOnFailure: { value: true }, continueOnFailure: { value: true } } })
const run = () => pieceExecutor.handle({ action: action(), executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants({ engineToken: token, internalApiUrl: 'http://127.0.0.1:1/' }) })
beforeEach(() => {
    vi.clearAllMocks()
    mockGetPieceAndAction.mockResolvedValue({ piece: { auth: undefined }, pieceAction: { name: 'askAi', props: {}, requireAuth: false, run: async (context: { run: { callAi: (request: object) => Promise<unknown> } }) => context.run.callAi({ stepName: 'forged' }) } })
})
afterEach(() => vi.unstubAllGlobals())

describe('hosted AI accounting refusal at the actual piece executor boundary', () => {
    it.each(['HOSTING_CREDITS_EXHAUSTED', 'HOSTING_RUN_CREDIT_LIMIT', 'HOSTING_OPERATOR_BUDGET_EXHAUSTED', 'HOSTING_BYOK_SCOPE_DENIED', 'HOSTING_NATIVE_CREDIT_LIMIT', 'HOSTING_NATIVE_FEATURE_DENIED', 'HOSTING_AI_FILE_UNAVAILABLE', 'HOSTING_AI_STEP_DENIED', 'HOSTING_NATIVE_PRICING_APPROVAL_REQUIRED'])('turns verified %s into one terminal FAILED AI step even when generic retry and continue are enabled', async code => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ code }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetch)
        const result = await run()
        expect(fetch).toHaveBeenCalledTimes(1)
        const request = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
        expect(request.stepName).toBe('ai')
        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.steps.ai.status).toBe('FAILED')
        expect(result.steps.ai.errorMessage).toContain(hostedAiRefusalMessage(403, { code }))
        expect(result.steps.ai.errorMessage).not.toContain('HOSTING_')
        expect(result.steps.ai.errorMessage).not.toContain('DeepSeek')
    })

    it.each(['HOSTING_AI_OUTCOME_UNCERTAIN', 'HOSTING_AI_OUTCOME_UNAVAILABLE', 'UNREVIEWED_ERROR'])('keeps unknown %s on the engine uncertainty path instead of claiming a definitive free refusal', async code => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ code }), { status: 403 }))
        vi.stubGlobal('fetch', fetch)
        await expect(run()).rejects.toBeInstanceOf(EngineGenericError)
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('does not trust the refusal code on a different HTTP status or an invalid body', () => {
        expect(hostedAiRefusalMessage(500, { code: 'HOSTING_CREDITS_EXHAUSTED' })).toBeNull()
        expect(hostedAiRefusalMessage(403, 'HOSTING_CREDITS_EXHAUSTED')).toBeNull()
        expect(hostedAiRefusalMessage(403, null)).toBeNull()
    })
})
