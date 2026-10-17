import { z } from 'zod'
import { hostingFail } from './hosting-transactions'

const usage = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative(), prompt_cache_hit_tokens: z.number().int().nonnegative(), prompt_cache_miss_tokens: z.number().int().nonnegative() })
const chunk = z.object({ id: z.string().min(1).max(256), model: z.string().max(128), created: z.number().int(), choices: z.array(z.object({ index: z.literal(0), finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable(), delta: z.object({ role: z.literal('assistant').optional(), content: z.string().nullable().optional(), tool_calls: z.array(z.object({ index: z.number().int().min(0).max(15), id: z.string().max(256).optional(), type: z.literal('function').optional(), function: z.object({ name: z.string().max(128).optional(), arguments: z.string().optional() }).optional() })).optional() }) })).max(1), usage: usage.nullish() })

// No tool arguments or finish event leave this parser before durable settlement.
export function createHostedStreamParser(model: string) {
    let buffer = '', bytes = 0, content = '', done = false
    let metadata: { id: string, model: string, created: number } | undefined
    let finish: string | undefined, verifiedUsage: z.infer<typeof usage> | undefined
    const tools = new Map<number, { id: string, type: 'function', function: { name: string, arguments: string } }>()
    function event(frame: string): string[] {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) return []
        if (done) hostingFail('HOSTING_AI_STREAM_INVALID')
        if (data === '[DONE]') {
            done = true; return []
        }
        let value: unknown
        try {
            value = JSON.parse(data)
        }
        catch {
            hostingFail('HOSTING_AI_STREAM_INVALID')
        }
        const parsed = chunk.safeParse(value)
        if (!parsed.success || parsed.data.model !== model) hostingFail('HOSTING_AI_STREAM_INVALID')
        const part = parsed.data
        if (metadata && (metadata.id !== part.id || metadata.created !== part.created)) hostingFail('HOSTING_AI_STREAM_INVALID')
        metadata = { id: part.id, model: part.model, created: part.created }
        const choice = part.choices[0]
        if ((finish || verifiedUsage) && (choice?.delta.content || choice?.delta.tool_calls?.length || choice?.finish_reason)) hostingFail('HOSTING_AI_STREAM_INVALID')
        const output: string[] = []
        if (choice?.delta.content) {
            content += choice.delta.content
            output.push(encode({ ...metadata, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: choice.delta.content }, finish_reason: null }] }))
        }
        for (const delta of choice?.delta.tool_calls ?? []) {
            const tool = tools.get(delta.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
            if (delta.id) {
                if (tool.id && tool.id !== delta.id) hostingFail('HOSTING_AI_STREAM_INVALID'); tool.id = delta.id
            }
            tool.function.name += delta.function?.name ?? ''
            tool.function.arguments += delta.function?.arguments ?? ''
            if (tool.function.arguments.length > 16384 || tool.function.name.length > 128) hostingFail('HOSTING_AI_STREAM_LIMIT')
            tools.set(delta.index, tool)
        }
        if (choice?.finish_reason) finish = choice.finish_reason
        if (part.usage) {
            if (!finish || verifiedUsage) hostingFail('HOSTING_AI_STREAM_INVALID')
            verifiedUsage = part.usage
        }
        return output
    }
    return {
        push(text: string): string[] {
            bytes += Buffer.byteLength(text)
            if (bytes > 2 * 1024 * 1024) hostingFail('HOSTING_AI_STREAM_LIMIT')
            buffer = (buffer + text).replace(/\r\n/g, '\n')
            const output: string[] = []
            let boundary: number
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                output.push(...event(buffer.slice(0, boundary))); buffer = buffer.slice(boundary + 2)
            }
            return output
        },
        finish() {
            if (buffer.trim() || !done || !metadata || !finish || !verifiedUsage) hostingFail('HOSTING_AI_USAGE_UNVERIFIED')
            const calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([index, tool]) => {
                if (!tool.id || !tool.function.name || index >= tools.size) hostingFail('HOSTING_AI_STREAM_INVALID')
                return tool
            })
            if ((finish === 'tool_calls') !== (calls.length > 0)) hostingFail('HOSTING_AI_STREAM_INVALID')
            return { ...metadata, object: 'chat.completion' as const, choices: [{ index: 0 as const, finish_reason: finish, message: { role: 'assistant' as const, content: content || null, ...(calls.length ? { tool_calls: calls } : {}) } }], usage: verifiedUsage }
        },
    }
}

export function settledCompletionStream(response: Record<string, unknown>, textAlreadySent = false): string[] {
    const value = response as { id: string, model: string, created: number, choices: { message: { content: string | null, tool_calls?: unknown[] }, finish_reason: string }[], usage: unknown }
    const choice = value.choices[0]
    const delta = { role: 'assistant', ...(!textAlreadySent ? { content: choice.message.content } : {}), ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool as object, index })) } : {}) }
    return [encode({ id: value.id, model: value.model, created: value.created, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: choice.finish_reason }], usage: value.usage }), 'data: [DONE]\n\n']
}
function encode(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`
}
