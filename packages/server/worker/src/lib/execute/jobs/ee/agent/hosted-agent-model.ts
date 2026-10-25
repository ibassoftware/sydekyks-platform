import { createHash } from 'node:crypto'
import { AgentConfigResponse } from '@activepieces/shared'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, RetryError, tool, ToolSet } from 'ai'
import { z } from 'zod'
import { JobContext } from '../../../types'

export const HOSTED_AGENT_MAX_OUTPUT = 4096

export function hostedAgentFailureMessage(message: string): string {
    if (/HOSTING_AI_RATE_LIMITED/.test(message)) return 'This workspace has made too many AI requests in a short time. Wait a minute before sending again.'
    if (/HOSTING_CREDITS_EXHAUSTED/.test(message)) return 'Not enough Credits are available for this reply. Check billing or contact your workspace administrator.'
    if (/HOSTING_(AI|NATIVE)_FILE_(EXPIRED|DELETED|UNAVAILABLE|INVALID|CHANGED|SCOPE_DENIED)/.test(message)) return 'An attachment is no longer available. Upload it again or start a new chat.'
    if (/HOSTING_AI_CALL_LIMIT/.test(message)) return 'This request reached the limit on AI calls. Start a new request with a smaller task.'
    if (/HOSTING_NATIVE_(TOOL|CREDIT|OUTPUT)_LIMIT|HOSTING_RUN_CREDIT_LIMIT/.test(message)) return 'This reply reached its safety limit. Start a shorter request or contact your workspace administrator.'
    if (/HOSTING_AI_CAPABILITY_DENIED|HOSTING_NATIVE_FEATURE_DENIED/.test(message)) return 'This feature is not available for the selected AI connection. Ask your workspace administrator to review its settings.'
    if (/HOSTING_NATIVE_URL_DENIED/.test(message)) return 'This page cannot be opened. Choose a public HTTPS page.'
    if (/HOSTING_NATIVE_PRICING_APPROVAL_REQUIRED/.test(message)) return 'Web search is awaiting administrator approval. Ask your workspace administrator to review its settings.'
    if (/HOSTING_AI_STEP_DENIED/.test(message)) return 'This AI step no longer matches the saved Mission. Refresh its configuration before running again.'
    if (/HOSTING_OPERATOR_BUDGET_EXHAUSTED/.test(message)) return 'Sydekyks AI is temporarily unavailable. Your workspace administrator can help you choose another billing option.'
    if (/HOSTING_BYOK_|HOSTING_EXACT_BYOK_KEY_REQUIRED/.test(message)) return 'Your selected key is no longer available for this workspace. Choose an available billing option before sending again.'
    if (/HOSTING_AI_OUTCOME_UNCERTAIN/.test(message)) return 'The provider response could not be verified. Credits may remain held while this is reviewed. Contact your workspace administrator before retrying.'
    if (/HOSTING_(ENTITLEMENT|GRANT|ACCESS|PROJECT_ACCESS)|HOSTING_AI_SEGMENT_DENIED/.test(message)) return 'This run no longer has access to the workspace or its credits. Refresh your session and check your available credits.'
    if (/Payload Too Large|HOSTING_AI_(REQUEST|STREAM)_LIMIT/.test(message)) return 'This conversation exceeds the current chat limits. Start a new chat with a shorter message.'
    return 'This reply could not be completed. Check your available credits and selected billing option before sending again.'
}

// Only the authenticated internal gateway can turn a managed-provider failure
// into a definitive user refusal. Upstream statuses/bodies remain untrusted.
export function hostedAgentRefusalOf(error: unknown, internalApiUrl: string): { code: string, message: string } | null {
    const cause = RetryError.isInstance(error) ? error.lastError : error
    if (!APICallError.isInstance(cause) || ![403, 413, 429].includes(cause.statusCode ?? 0)) return null
    // The SDK constructs a URL, which removes explicit default ports (80/443).
    // Pin the canonical endpoint, retaining origin, effective port and full path.
    // Query strings, fragments and userinfo never identify our gateway receipt.
    try {
        const internal = new URL(internalApiUrl)
        const target = new URL(cause.url)
        if (![internal, target].every(url => ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)) return null
        const base = `${internal.href.replace(/\/$/, '')}/v1/engine/hosting-ai/copilot`
        if (![`${base}/completions`, `${base}/chat/completions`].includes(target.href)) return null
    }
    catch {
        return null
    }
    let body: unknown
    try {
        body = JSON.parse(cause.responseBody ?? '')
    }
    catch {
        return null
    }
    // Only our pinned gateway may attest that parsing/rate admission rejected
    // this HTTP call before any supplier dispatch. Unknown upstream 413/429s
    // and transport failures remain uncertain; no retries or refunds are inferred.
    if (cause.statusCode === 413 || cause.statusCode === 429) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('code' in body)) return null
        const expected = cause.statusCode === 413 ? 'HOSTING_AI_REQUEST_LIMIT' : 'HOSTING_AI_RATE_LIMITED'
        const receipt = 'receipt' in body ? body.receipt : null
        const attested = receipt && typeof receipt === 'object' && 'version' in receipt && receipt.version === 1 && 'phase' in receipt && receipt.phase === 'pre_dispatch'
        const legacyParserReceipt = cause.statusCode === 413 && body.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        if (!(body.code === expected && attested) && !legacyParserReceipt) return null
        return { code: expected, message: hostedAgentFailureMessage(expected) }
    }
    if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string' || !['HOSTING_CREDITS_EXHAUSTED', 'HOSTING_RUN_CREDIT_LIMIT', 'HOSTING_AI_CALL_LIMIT', 'HOSTING_NATIVE_CREDIT_LIMIT', 'HOSTING_NATIVE_TOOL_LIMIT', 'HOSTING_AI_FILE_UNAVAILABLE', 'HOSTING_AI_CAPABILITY_DENIED', 'HOSTING_NATIVE_OUTPUT_LIMIT', 'HOSTING_AI_REQUEST_LIMIT', 'HOSTING_NATIVE_FEATURE_DENIED', 'HOSTING_NATIVE_URL_DENIED', 'HOSTING_NATIVE_PRICING_APPROVAL_REQUIRED', 'HOSTING_AI_STEP_DENIED', 'HOSTING_AI_FILE_CHANGED', 'HOSTING_AI_FILE_INVALID', 'HOSTING_AI_FILE_SCOPE_DENIED', 'HOSTING_OPERATOR_BUDGET_EXHAUSTED', 'HOSTING_BYOK_SCOPE_DENIED', 'HOSTING_EXACT_BYOK_KEY_REQUIRED'].includes(body.code)) return null
    return { code: body.code, message: hostedAgentFailureMessage(body.code) }
}

const SCHEMA_ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment'])
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const SCHEMA_CHILDREN = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema'])
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

// Walk schema positions only. A property or definition named "description" is
// data in a schema map; enum/const/default and unknown keyword values are data
// too. Dropping their keys recursively would silently change validation.
export function compactHostedNativeToolSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
    return Object.fromEntries(Object.entries(schema).filter(([key]) => !SCHEMA_ANNOTATIONS.has(key)).map(([key, value]) => {
        if ((SCHEMA_MAPS.has(key) || key === 'dependencies') && value && typeof value === 'object' && !Array.isArray(value)) {
            return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compactHostedNativeToolSchema(child)]))]
        }
        if (SCHEMA_ARRAYS.has(key) && Array.isArray(value)) return [key, value.map(compactHostedNativeToolSchema)]
        if (SCHEMA_CHILDREN.has(key)) return [key, Array.isArray(value) ? value.map(compactHostedNativeToolSchema) : compactHostedNativeToolSchema(value)]
        return [key, value]
    }))
}

type HostedWireTool = { type: string, function: { name: string, description?: string, parameters?: unknown } }
function hostedToolWire(entry: HostedWireTool, native: boolean): HostedWireTool {
    const fullDescription = entry.function.description
    const firstSentence = fullDescription?.trim().match(/^([\s\S]*?[.!?])(?=\s|$)/)?.[1]
    return { type: entry.type, function: {
        name: entry.function.name,
        description: native ? (firstSentence ?? fullDescription)?.slice(0, 512) : fullDescription,
        parameters: native ? compactHostedNativeToolSchema(entry.function.parameters ?? {}) : entry.function.parameters ?? {},
    } }
}

export function createHostedAgentModel({ ctx, config }: { ctx: JobContext, config: NonNullable<AgentConfigResponse['hosted']> }) {
    if (!ctx.admissionId || config.protocol !== 1 || config.model !== (config.payer.type === 'managed' ? 'sydekyks' : 'deepseek-flash')) throw new Error('HOSTING_AI_SEGMENT_DENIED')
    let sequence = 0
    const native = config.nativeWebSearch === true || Boolean(config.nativeFileIds?.length)
    return createOpenAICompatible({
        name: 'sydekyks', baseURL: `${ctx.internalApiUrl.replace(/\/$/, '')}/v1/engine/hosting-ai/copilot`, includeUsage: true,
        fetch: async (_url, init) => {
            if (typeof init?.body !== 'string') throw new Error('HOSTING_AI_REQUEST_INVALID')
            const wire = JSON.parse(init.body)
            // SDK/provider options never control the endpoint, payer, retry identity or key.
            const { model, messages, max_tokens, temperature, response_format, tools, tool_choice, stream } = wire
            if (model !== config.model) throw new Error('HOSTING_AI_MODEL_DENIED')
            const payload = { callKey: `copilot:${sequence++}`, attempt: 0, payer: config.payer, model, messages, fileIds: config.nativeFileIds ?? [], max_tokens: Math.min(max_tokens ?? 1024, config.nativeWebSearch || config.nativeFileIds?.length ? 2048 : HOSTED_AGENT_MAX_OUTPUT), temperature, response_format, tools: tools?.map((entry: HostedWireTool) => hostedToolWire(entry, native)), tool_choice, stream: stream === true }
            return fetch(`${ctx.internalApiUrl.replace(/\/$/, '')}/v1/engine/hosting-ai/copilot/completions`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.engineToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: init?.signal })
        },
    }).chatModel(config.model)
}

// Local, cost-free tools only. Provider/MCP/piece/nested-flow tools stay unavailable
// until their side effects and spend have inherited admission and accounting.
export function hostedAgentTools(config: AgentConfigResponse): ToolSet {
    return {
        ap_get_workspace_context: tool({ description: 'Read the workspace and model context for this run.', inputSchema: z.object({}), execute: async () => ({ projects: config.projects, model: config.modelId, payer: config.hosted?.payer.type }) }),
        ap_update_thinking_status: tool({ description: 'Describe the next reasoning step.', inputSchema: z.object({ status: z.string().max(256) }), execute: async () => ({ success: true }) }),
    }
}

// Hosted web access has its own admitted gateway. Never expose the ordinary
// HTTP/Tavily/provider tools here: those bypass the single Credits ledger.
export function createHostedNativeWebTools({ ctx, config, taintState, abortSignal }: { ctx: JobContext, config: NonNullable<AgentConfigResponse['hosted']>, taintState: { tainted: boolean }, abortSignal?: AbortSignal }): ToolSet {
    if (!config.nativeWebSearch) return {}
    // SDK tool execution may fan out with Promise.all. Search and page reads
    // share one queue so each request observes the preceding accounting outcome.
    let tail: Promise<void> = Promise.resolve()
    let uncertain = false
    const invoke = (kind: 'search' | 'fetch', input: { query?: string, url?: string }, toolCallId: string) => {
        const pending = tail.then(async () => {
            // A queued cancellation is known unsent: do not open a new request.
            if (abortSignal?.aborted || !ctx.admissionId || !toolCallId) throw new Error('HOSTING_AI_SEGMENT_DENIED')
            if (uncertain) throw new Error('HOSTING_AI_OUTCOME_UNCERTAIN')
            taintState.tainted = true
            try {
                const response = await fetch(`${ctx.internalApiUrl.replace(/\/$/, '')}/v1/engine/hosting-ai/tools`, {
                    method: 'POST', headers: { Authorization: `Bearer ${ctx.engineToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callKey: `native:${createHash('sha256').update(toolCallId).digest('hex')}`, attempt: 0, payer: config.payer, model: config.model, kind, ...input }), signal: abortSignal,
                })
                // Never replay an unknown send. The gateway retains its hold;
                // subsequent queued calls must not send while it needs review.
                if (!response.ok) {
                    const failure = await response.json().catch(() => null) as { code?: unknown } | null
                    throw new Error(typeof failure?.code === 'string' && /^HOSTING_[A-Z_]+$/.test(failure.code) ? failure.code : 'HOSTING_AI_OUTCOME_UNCERTAIN')
                }
                const text = await response.text()
                if (text.length > 24000) throw new Error('HOSTING_AI_REQUEST_LIMIT')
                return JSON.parse(text)
            }
            catch (error) {
                const failure = error instanceof Error && /^HOSTING_[A-Z_]+$/.test(error.message) ? error : new Error('HOSTING_AI_OUTCOME_UNCERTAIN')
                if (/^HOSTING_AI_OUTCOME_(UNCERTAIN|UNAVAILABLE)$/.test(failure.message)) uncertain = true
                throw failure
            }
        })
        // Keep the queue usable after a known unsent refusal, while an uncertain
        // outcome remains latched separately for the rest of this turn.
        tail = pending.then(() => undefined, () => undefined)
        return pending
    }
    return {
        ap_search_web: tool({ description: 'Search the public web and return bounded excerpts with source URLs. Limited to two searches in this turn.', inputSchema: z.object({ query: z.string().trim().min(1).max(128) }), execute: (input, options) => invoke('search', input, options.toolCallId) }),
        ap_read_web_page: tool({ description: 'Read bounded excerpts from a public HTTPS page and return its source URL. Limited to three page reads in this turn.', inputSchema: z.object({ url: z.string().url().max(2048) }), execute: (input, options) => invoke('fetch', input, options.toolCallId) }),
    }
}
