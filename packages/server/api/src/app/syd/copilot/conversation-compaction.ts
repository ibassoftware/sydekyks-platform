import { readFileSync } from 'node:fs'
import { ActivepiecesError, AIProviderName, ErrorCode, tryCatch } from '@activepieces/core-utils'
import { aiProviderUtils } from '@activepieces/shared'
import { generateText, LanguageModel, ModelMessage } from 'ai'
import { FastifyBaseLogger } from 'fastify'

function tokenCost(codePoint: string): number {
    return codePoint.codePointAt(0) !== undefined && codePoint.charCodeAt(0) < 128 ? 0.25 : 1
}
function tokensIn(text: string): number {
    return Math.ceil(Array.from(text).reduce((cost, point) => cost + tokenCost(point), 0))
}

function estimateTokenCount({ messages, systemPromptLength }: { messages: ModelMessage[], systemPromptLength: number }): number {
    return tokensIn(JSON.stringify(messages)) + Math.ceil(systemPromptLength / 4)
}

function contextBudget({ provider, reservedTokens }: BudgetParams): number {
    return Math.max(0, aiProviderUtils.getMaxContextTokens({ provider }) - reservedTokens)
}

function recentWindowSizeFor({ messages, targetTokens }: { messages: ModelMessage[], targetTokens: number }): number {
    let count = 0
    let consumed = 0
    for (const message of messages.slice(1).reverse()) {
        if (consumed >= targetTokens) break
        consumed += tokensIn(JSON.stringify(message))
        count++
    }
    return Math.min(Math.max(2, count), Math.max(0, messages.length - 1))
}

function shouldCompact({ estimatedTokens, provider, messageCount, reservedTokens }: BudgetParams & { estimatedTokens: number, messageCount: number }): boolean {
    return messageCount >= 6 && estimatedTokens > contextBudget({ provider, reservedTokens }) * 0.7
}

function snapToSafeMessageBoundary({ messages, rawCutoff }: { messages: ModelMessage[], rawCutoff: number }): number {
    let start = Math.min(Math.max(0, rawCutoff), Math.max(0, messages.length - 1))
    while (start > 0 && messages[start]?.role === 'tool') start--
    return start
}

function fairShareCap({ lengths, budget }: { lengths: number[], budget: number }): number {
    let remaining = budget
    const ordered = [...lengths].sort((left, right) => left - right)
    for (const [index, length] of ordered.entries()) {
        const allowance = Math.floor(remaining / (ordered.length - index))
        if (length > allowance) return Math.max(0, allowance)
        remaining -= length
    }
    return Infinity
}

function truncateToTokens({ text, maxTokens }: { text: string, maxTokens: number }): string {
    if (tokensIn(text) <= maxTokens) return text
    let cost = 0
    let count = 0
    const points = Array.from(text)
    for (const point of points) {
        if (cost + tokenCost(point) > maxTokens) break
        cost += tokenCost(point)
        count++
    }
    return `${points.slice(0, count).join('')}…[truncated ${points.length - count} chars]`
}

function truncateForSummary({ output, limit }: { output: string, limit: number }): string {
    const points = Array.from(output)
    return points.length <= limit ? output : `${points.slice(0, limit).join('')}…[truncated ${points.length - limit} chars]`
}

function extractTextContent(message: ModelMessage): string {
    if (typeof message.content === 'string') return message.content
    return message.content.map((part) => {
        if (part.type === 'text') return part.text
        if (part.type === 'tool-call') return `[Tool call: ${part.toolName}]`
        if (part.type === 'tool-result') return `[Tool result: ${truncateForSummary({ output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output), limit: 2000 })}]`
        return ''
    }).join('')
}

async function compactMessages({ messages, existingSummary, summarizedUpToIndex, provider, reservedTokens, model, log }: CompactionParams): Promise<CompactionResult> {
    const from = summarizedUpToIndex ?? 0
    const recent = recentWindowSizeFor({ messages, targetTokens: contextBudget({ provider, reservedTokens }) * 0.3 })
    const to = snapToSafeMessageBoundary({ messages, rawCutoff: messages.length - recent })
    const prior = { summary: existingSummary ?? '', summarizedUpToIndex: from }
    if (to <= from) return prior
    const instructions = readFileSync('packages/server/api/src/assets/prompts/chat-compaction-prompt.md', 'utf8')
    const prefix = existingSummary ? `Previous conversation summary:\n${existingSummary}\n\nNew messages since last summary:\n` : ''
    const selected = messages.slice(from, to)
    const texts = selected.map(extractTextContent)
    const cap = fairShareCap({ lengths: texts.map(tokensIn), budget: contextBudget({ provider, reservedTokens: 4000 }) * 0.7 - tokensIn(instructions + prefix) })
    const prompt = prefix + texts.map((text, index) => `[${selected[index].role}]: ${truncateToTokens({ text, maxTokens: cap })}\n`).join('')
    const outcome = await tryCatch(() => generateText({ model, instructions, prompt, maxOutputTokens: 4000, abortSignal: AbortSignal.timeout(35_000) }))
    if (outcome.error) {
        log.warn({ error: outcome.error }, 'Syd conversation summarization failed')
        return prior
    }
    return { summary: outcome.data.text, summarizedUpToIndex: to }
}

function buildCompactedPayload({ messages, summary, summarizedUpToIndex, provider, reservedTokens }: PayloadParams): ModelMessage[] {
    const tail = summary ? messages.slice(summarizedUpToIndex ?? 0) : messages
    const block = summary ? `[Previous conversation summary]\n${summary}\n[End of summary — conversation continues below]` : ''
    const budget = contextBudget({ provider, reservedTokens })
    const costs = tail.map((message) => tokensIn(JSON.stringify(message)))
    let total = costs.reduce((sum, cost) => sum + cost, 0) + tokensIn(JSON.stringify(block))
    let first = 0
    while (first < tail.length - 1 && (total > budget * 0.7 || tail[first].role === 'tool')) total -= costs[first++]
    if (total > budget) throw new ActivepiecesError({ code: ErrorCode.CHAT_CONTEXT_LIMIT_EXCEEDED, params: {} })
    const retained = tail.slice(first)
    const note = [first ? `[${first} earlier messages were left out to fit the context window]` : '', block].filter(Boolean).join('\n')
    if (!note) return retained
    const head = retained[0]
    if (head?.role !== 'user') return [{ role: 'user', content: note }, ...retained]
    const merged: ModelMessage = typeof head.content === 'string'
        ? { ...head, content: `${note}\n\n${head.content}` }
        : { ...head, content: [{ type: 'text', text: note }, ...head.content] }
    return [merged, ...retained.slice(1)]
}

export const sydConversationCompaction = {
    tokenCost, tokensIn, estimateTokenCount, contextBudget, recentWindowSizeFor, shouldCompact, snapToSafeMessageBoundary,
    fairShareCap, truncateToTokens, truncateForSummary, extractTextContent, compactMessages, buildCompactedPayload,
}

type BudgetParams = { provider: AIProviderName, reservedTokens: number }
type PayloadParams = BudgetParams & { messages: ModelMessage[], summary: string | null, summarizedUpToIndex: number | null }
type CompactionParams = BudgetParams & { messages: ModelMessage[], existingSummary: string | null, summarizedUpToIndex: number | null, model: LanguageModel, log: FastifyBaseLogger }
type CompactionResult = { summary: string, summarizedUpToIndex: number }
