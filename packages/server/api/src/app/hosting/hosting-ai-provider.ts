import { safeHttp } from '@activepieces/server-utils'
import { HostedPlanId } from '@activepieces/shared'
import { HOSTED_AI_TIMEOUT_MS, HOSTED_DEEPSEEK_ENDPOINT, HOSTED_DEEPSEEK_MODEL, HOSTED_DEEPSEEK_PRO_MODEL, HOSTED_MANAGED_MODEL, HostedAiInput } from './hosting-ai-policy'
import { HOSTED_CREDIT_ACCOUNTING_VERSION } from './hosting-credit-policy'

// Logical customer model stays stable when another reviewed supplier is added.
// Only this server catalog controls routing; browser input cannot supply endpoints.
export const hostedModelCatalog = Object.freeze({
    [HOSTED_DEEPSEEK_MODEL]: Object.freeze({
        id: HOSTED_MANAGED_MODEL, provider: 'deepseek', upstreamModel: HOSTED_DEEPSEEK_MODEL,
        endpoint: HOSTED_DEEPSEEK_ENDPOINT, accountingVersion: 'deepseek-verified-usage-v1', creditConversionVersion: HOSTED_CREDIT_ACCOUNTING_VERSION,
        capabilities: Object.freeze({ tools: true, json: true, stream: true, vision: true }),
        allowedPlans: Object.freeze(['trial', 'training', 'assessment', 'starter', 'team', 'scale'] as HostedPlanId[]),
    }),
    [HOSTED_DEEPSEEK_PRO_MODEL]: Object.freeze({
        id: HOSTED_MANAGED_MODEL, provider: 'deepseek', upstreamModel: HOSTED_DEEPSEEK_PRO_MODEL,
        endpoint: HOSTED_DEEPSEEK_ENDPOINT, accountingVersion: 'deepseek-verified-usage-v1', creditConversionVersion: HOSTED_CREDIT_ACCOUNTING_VERSION,
        capabilities: Object.freeze({ tools: true, json: true, stream: true, vision: false }),
        allowedPlans: Object.freeze(['trial', 'training', 'assessment', 'starter', 'team', 'scale'] as HostedPlanId[]),
    }),
})

export type HostedProviderInput = Omit<HostedAiInput, 'messages'> & { messages: Array<HostedAiInput['messages'][number] | { role: 'user', content: Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }> }> }
export type HostedProviderRequest = { request: HostedProviderInput, apiKey: string, stream: boolean, signal?: AbortSignal }
export type HostedProviderResponse = { status: number, data: unknown }
export type HostedAiProvider = {
    // Injected only by trusted server composition/diagnostics, never tenant settings.
    id: string
    endpoint: string
    complete(input: HostedProviderRequest): Promise<HostedProviderResponse>
}

// Additional adapters must normalize responses/stream usage to the gateway's
// verified accounting contract before being enabled for managed spending.
export const deepseekHostedProvider: HostedAiProvider = {
    id: 'deepseek-direct-v1', endpoint: HOSTED_DEEPSEEK_ENDPOINT,
    async complete({ request, apiKey, stream, signal }) {
        const model = hostedModelCatalog[request.model === HOSTED_MANAGED_MODEL ? HOSTED_DEEPSEEK_MODEL : request.model]
        return safeHttp.axios.request<unknown>({
            method: 'POST', url: model.endpoint,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            data: hostedProviderBody(request, stream),
            responseType: stream ? 'stream' : 'json', signal, timeout: HOSTED_AI_TIMEOUT_MS,
            maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 32 * 1024 * 1024, validateStatus: () => true,
        })
    },
}

export function hostedProviderBody(request: HostedProviderInput, stream: boolean) {
    const model = hostedModelCatalog[request.model === HOSTED_MANAGED_MODEL ? HOSTED_DEEPSEEK_MODEL : request.model]
    return { model: model.upstreamModel, messages: request.messages, max_tokens: request.max_tokens, temperature: request.temperature, response_format: request.response_format, tools: request.tools, tool_choice: request.tool_choice, thinking: { type: 'disabled' }, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }
}
