import { readFileSync } from 'node:fs'
import { tryCatch, tryCatchSync } from '@activepieces/core-utils'
import { GetAgentMemoryResponse } from '@activepieces/shared'
import { generateText } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { sydCopilotContext } from './copilot-context'

function loadMemoryPrompt(filename: string): string {
    return readFileSync(`packages/server/api/src/assets/prompts/${filename}`, 'utf8')
}

function parseJsonObject<T>({ raw, schema }: { raw: string, schema: z.ZodType<T> }): T | null {
    const first = raw.indexOf('{')
    const last = raw.lastIndexOf('}')
    if (first < 0 || last <= first) return null
    const result = tryCatchSync(() => {
        const value: unknown = JSON.parse(raw.slice(first, last + 1)); return schema.safeParse(value)
    })
    return result.data?.success ? result.data.data : null
}

function naiveSplit(text: string): GetAgentMemoryResponse {
    return sydCopilotContext.capMemories({ instructions: null, memories: text.split('\n').map((line) => line.replace(/^[-*\d.)\s]+/, '').trim()) })
}

async function runMemoryLlm<T>({ platformId, instructions, prompt, schema, log }: { platformId: string, instructions: string, prompt: string, schema: z.ZodType<T>, log: FastifyBaseLogger }): Promise<T | null> {
    const result = await tryCatch(async () => {
        const model = await sydCopilotContext.resolveFastModel({ platformId, scope: { type: 'platform' }, surface: 'chat', log })
        const generated = await generateText({ model, instructions, prompt, temperature: 0 })
        return parseJsonObject({ raw: generated.text, schema })
    })
    if (result.error) log.warn({ error: result.error, platform: { id: platformId } }, 'Syd memory reconciliation fell back to local processing')
    return result.data ?? null
}

async function extract({ platformId, text, log }: { platformId: string, text: string, log: FastifyBaseLogger }): Promise<GetAgentMemoryResponse> {
    const trimmed = text.trim().slice(0, 50_000)
    if (!trimmed) return { instructions: null, memories: [] }
    const result = await runMemoryLlm({ platformId, instructions: loadMemoryPrompt('chat-memory-extraction-prompt.md'), prompt: trimmed, schema: ExtractionSchema, log })
    return result ? sydCopilotContext.capMemories(result) : naiveSplit(trimmed)
}

async function applyInstruction({ platformId, userId, instruction, log }: { platformId: string, userId: string, instruction: string, log: FastifyBaseLogger }): Promise<GetAgentMemoryResponse> {
    const current = await sydCopilotContext.getUserMemory({ platformId, userId })
    const trimmed = instruction.trim().slice(0, 50_000)
    if (!trimmed) return current
    const prompt = `Current memories:\n${current.memories.length ? current.memories.map((memory) => `- ${memory}`).join('\n') : '(none yet)'}\n\nInput: ${trimmed}`
    const result = await runMemoryLlm({ platformId, instructions: loadMemoryPrompt('chat-memory-instruction-prompt.md'), prompt, schema: MemoriesSchema, log })
    return sydCopilotContext.saveUserMemory({ platformId, userId, memories: result?.memories ?? [...current.memories, trimmed], baseMemories: current.memories })
}

const ExtractionSchema = z.object({ instructions: z.string().catch(''), memories: z.array(z.string().catch('')).catch([]) })
const MemoriesSchema = z.object({ memories: z.array(z.string().catch('')).catch([]) })

export const sydMemoryEditor = { loadMemoryPrompt, parseJsonObject, naiveSplit, runMemoryLlm, extract, applyInstruction, ExtractionSchema, MemoriesSchema }
