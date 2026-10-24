import { z } from 'zod'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { hostingFail } from './hosting-transactions'

export const HostedKeyAuth = z.strictObject({ apiKey: z.string().min(16).max(512).regex(/^\S+$/) })
export const HOSTED_MANAGED_MODEL = 'sydekyks'
export const HOSTED_DEEPSEEK_MODEL = 'deepseek-flash'
export const HOSTED_DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro'
export const HOSTED_DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const HOSTED_AI_CONTEXT_TOKENS = 1_048_576
export const HOSTED_AI_MAX_OUTPUT = 4096
export const HOSTED_AI_TIMEOUT_MS = 60_000
export const HOSTED_AI_MAX_CALLS = 32
// Transport/storage protection is separate from supplier context. Larger full
// conversations reserve the approved entire model context before supplier send.
export const HOSTED_AI_REQUEST_MAX_BYTES = 1024 * 1024
export const HOSTED_AI_MAX_MESSAGES = 512

const toolCall = z.strictObject({ id: z.string().max(256), type: z.literal('function'), function: z.strictObject({ name: z.string().max(128), arguments: z.string().max(16384) }) })
const message = z.discriminatedUnion('role', [
    z.strictObject({ role: z.enum(['system', 'user']), content: z.string().max(32768) }),
    z.strictObject({ role: z.literal('assistant'), content: z.string().max(32768).nullable(), tool_calls: z.array(toolCall).max(16).optional() }),
    z.strictObject({ role: z.literal('tool'), content: z.string().max(32768), tool_call_id: z.string().max(256) }),
])
export const HostedAiRequest = z.strictObject({
    callKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), attempt: z.number().int().min(0).max(2).default(0),
    payer: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('managed') }), z.strictObject({ type: z.literal('byok'), configId: z.string().length(21) })]),
    model: z.enum([HOSTED_MANAGED_MODEL, HOSTED_DEEPSEEK_MODEL, HOSTED_DEEPSEEK_PRO_MODEL]), messages: z.array(message).min(1).max(HOSTED_AI_MAX_MESSAGES),
    stepName: z.string().min(1).max(256).optional(),
    fileIds: z.array(z.string().length(21)).max(20).optional(),
    max_tokens: z.number().int().min(1).max(HOSTED_AI_MAX_OUTPUT).default(1024), temperature: z.number().min(0).max(2).optional(),
    response_format: z.strictObject({ type: z.enum(['text', 'json_object']) }).optional(),
    tools: z.array(z.strictObject({ type: z.literal('function'), function: z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().max(2048).optional(), parameters: z.record(z.string(), z.unknown()) }) })).max(128).optional(),
    tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.strictObject({ type: z.literal('function'), function: z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }) })]).optional(), stream: z.literal(false).optional(),
})
export type HostedAiInput = z.infer<typeof HostedAiRequest>

const rate = z.number().int().min(0).max(1_000_000_000)
const rates = z.strictObject({ cacheHit: rate, cacheMiss: rate.positive(), output: rate.positive() })
export const HostedAiQuote = z.strictObject({
    version: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), model: z.enum([HOSTED_DEEPSEEK_MODEL, HOSTED_DEEPSEEK_PRO_MODEL]),
    validFrom: z.iso.datetime(), validUntil: z.iso.datetime(), rates, ceiling: rates,
})
export type HostedAiPrice = z.infer<typeof HostedAiQuote>

export function readHostedAiQuote(now: Date): HostedAiPrice {
    let value: unknown
    try {
        value = JSON.parse(system.get(AppSystemProp.HOSTED_DEEPSEEK_PRICE_JSON) ?? '')
    }
    catch {
        hostingFail('HOSTING_AI_PRICE_REQUIRED')
    }
    return validateHostedAiQuote(value, now)
}

export function validateHostedAiQuote(value: unknown, now: Date): HostedAiPrice {
    const parsed = HostedAiQuote.safeParse(value)
    if (!parsed.success) hostingFail('HOSTING_AI_PRICE_REQUIRED')
    const quote = parsed.data
    if (new Date(quote.validFrom) > now || new Date(quote.validUntil).getTime() < now.getTime() + HOSTED_AI_TIMEOUT_MS + 5000 || new Date(quote.validUntil).getTime() - new Date(quote.validFrom).getTime() > 3_600_000) hostingFail('HOSTING_AI_PRICE_EXPIRED')
    if (quote.rates.cacheHit > quote.rates.cacheMiss || quote.ceiling.cacheMiss < quote.rates.cacheMiss || quote.ceiling.cacheHit < quote.rates.cacheHit || quote.ceiling.output < quote.rates.output || quote.ceiling.cacheHit > quote.ceiling.cacheMiss) hostingFail('HOSTING_AI_PRICE_INVALID')
    return quote
}

export function hostedAiCost({ hit, miss, output, prices }: { hit: number, miss: number, output: number, prices: HostedAiPrice['rates'] }): bigint {
    return (BigInt(hit) * BigInt(prices.cacheHit) + BigInt(miss) * BigInt(prices.cacheMiss) + BigInt(output) * BigInt(prices.output) + 999_999n) / 1_000_000n
}

/** Small requests retain the conservative UTF-8 estimate (4x bytes plus
 * framing). For larger preserved transcripts, reserve the approved full input
 * window instead of rejecting on that coarse estimate. The approved 1M context
 * includes output, so requested output is always deducted from the input ceiling.
 * Provider usage is still checked against the recorded bound; unexpected usage
 * quarantines the tenant. This does not promise the supplier accepts every body.
 */
export function hostedAiInputBound(input: HostedAiInput, additionalInputTokens = 0): number {
    const serialized = JSON.stringify({ messages: input.messages, tools: input.tools, tool_choice: input.tool_choice, response_format: input.response_format })
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > HOSTED_AI_REQUEST_MAX_BYTES || !Number.isSafeInteger(additionalInputTokens) || additionalInputTokens < 0) hostingFail('HOSTING_AI_REQUEST_LIMIT')
    const estimate = bytes * 4 + 4096 + (input.messages.length + (input.tools?.length ?? 0)) * 256 + additionalInputTokens
    return Math.min(estimate, HOSTED_AI_CONTEXT_TOKENS - input.max_tokens)
}
