import { AgentConversation, AgentHistoryMessage, AgentHistoryToolCall, PersistedAgentMessage } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'

function reconstruct(messages: unknown[]): AgentHistoryMessage[] {
    const history: AgentHistoryMessage[] = []
    for (const raw of messages) {
        const message = record(raw)
        if (!message) continue
        if (message.role === 'user') {
            const content = extractTextFromContent(message.content)
            if (content) history.push({ role: 'user', content })
            continue
        }
        if (message.role === 'assistant') {
            const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : records(message.content)
            const content = extractTextFromContent(parts)
            const thoughts = parts.filter((part) => part.type === 'reasoning' || part.type === 'thinking').map((part) => typeof part.text === 'string' ? part.text : '').join('')
            const toolCalls = parts.flatMap((part): AgentHistoryToolCall[] => {
                if (part.type !== 'tool-call' || typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') return []
                return [{ toolCallId: part.toolCallId, title: part.toolName, status: 'completed', input: record(part.input) ?? undefined }]
            })
            if (!content && !thoughts && !toolCalls.length) continue
            const prior = history.at(-1)
            if (!content && prior?.role === 'assistant') {
                history[history.length - 1] = { ...prior, toolCalls: [...prior.toolCalls ?? [], ...toolCalls], thoughts: [prior.thoughts, thoughts].filter(Boolean).join('\n') || undefined }
            }
            else {
                history.push({ role: 'assistant', content, ...(thoughts ? { thoughts } : {}), ...(toolCalls.length ? { toolCalls } : {}) })
            }
            continue
        }
        if (message.role !== 'tool') continue
        const prior = history.at(-1)
        if (prior?.role !== 'assistant' || !prior.toolCalls) continue
        const outputs = new Map(records(message.content).filter((part) => part.type === 'tool-result').map((part) => [part.toolCallId, part.output]))
        history[history.length - 1] = {
            ...prior,
            toolCalls: prior.toolCalls.map((call) => {
                if (!outputs.has(call.toolCallId)) return call
                const rawOutput = outputs.get(call.toolCallId)
                const envelope = record(rawOutput)
                const output = envelope?.type === 'json' && 'value' in envelope ? envelope.value : rawOutput
                return { ...call, output: typeof output === 'string' ? output : JSON.stringify(output), status: 'completed' }
            }),
        }
    }
    return history
}

function extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content
    return records(content).filter((part) => part.type === 'text').map((part) => typeof part.text === 'string' ? part.text : '').join('')
}

function resolveMessages({ conversation, log }: { conversation: AgentConversation, log: FastifyBaseLogger }): PersistedAgentMessage[] {
    if (conversation.uiMessages === null) {
        log.error({ conversation: { id: conversation.id } }, 'Syd conversation has no UI history')
    }
    return conversation.uiMessages ?? []
}

function record(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.fromEntries(Object.entries(value))
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.flatMap((part) => {
        const parsed = record(part); return parsed ? [parsed] : []
    }) : []
}

export const sydConversationHistory = { reconstruct, extractTextFromContent, resolveMessages }
