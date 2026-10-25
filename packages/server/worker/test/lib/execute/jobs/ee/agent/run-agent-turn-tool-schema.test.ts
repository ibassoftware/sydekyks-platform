import { AIProviderName } from '@activepieces/core-utils'
import { agentAiUtils } from '@activepieces/server-utils'
import { simulateReadableStream, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runAgentTurn, withExplicitToolStrictness } from '../../../../../../src/lib/execute/jobs/ee/agent/run-agent-turn'

afterEach(() => vi.restoreAllMocks())

describe('chat tool schema compatibility', () => {
    it('keeps flow and folder selectors optional at the model boundary', async () => {
        vi.spyOn(agentAiUtils, 'affordableOutputTokens').mockResolvedValue(1024)
        const model = new MockLanguageModelV4({
            doStream: async () => ({ stream: simulateReadableStream({ chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'reply' },
                { type: 'text-delta', id: 'reply', delta: 'Ready.' },
                { type: 'text-end', id: 'reply' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] }) }),
        })
        const validation = tool({ inputSchema: z.object({ flowId: z.string().optional(), folderName: z.string().optional() }), execute: async () => ({ valid: true }) })

        await runAgentTurn({
            model, provider: AIProviderName.OPENAI, modelId: 'gpt-4.1',
            systemPrompt: 'Check workflow access.', messages: [{ role: 'user', content: 'Check this flow.' }],
            tools: { ap_validate_flow: validation }, allToolNames: ['ap_validate_flow'],
            tier: { id: 'smart', modelId: 'gpt-4.1', thinkingBudget: 0 }, phaseState: { phase: 'build' },
            abortSignal: new AbortController().signal,
            log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            sinks: { drainStream: (result) => result.consumeStream() },
        })

        const sentTool = model.doStreamCalls[0].tools?.find((entry) => entry.name === 'ap_validate_flow')
        expect(sentTool?.type).toBe('function')
        if (sentTool?.type !== 'function') throw new Error('Validation tool was not sent to the model')
        expect(sentTool.strict).toBe(false)
        expect(sentTool.inputSchema.required ?? []).not.toContain('folderName')
        expect(sentTool.inputSchema.required ?? []).not.toContain('flowId')
    })

    it('preserves a tool that explicitly requires strict inputs', () => {
        const completion = tool({ strict: true, inputSchema: z.object({ result: z.string() }), execute: async () => ({ done: true }) })
        expect(withExplicitToolStrictness({ tools: { completion } })['completion'].strict).toBe(true)
    })
})


describe('Copilot public Gadget names in the model loop', () => {
    it.each(['direct', 'deferred'])('keeps %s calls branded on the wire and canonical during execution', async mode => {
        vi.spyOn(agentAiUtils, 'affordableOutputTokens').mockResolvedValue(1024)
        const original = '@activepieces/piece-forms'
        const branded = '@sydekyks/piece-forms'
        const execute = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ pieces: [{ name: original }] }) }], structuredContent: { pieces: [{ name: original }] } }))
        let calls = 0
        const model = new MockLanguageModelV4({
            doStream: async () => ({ stream: simulateReadableStream({ chunks: ++calls === 1 ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'research', toolName: mode === 'direct' ? 'ap_research_pieces' : 'ap_lazy_tool', input: JSON.stringify(mode === 'direct' ? { pieceNames: [branded] } : { tool: 'ap_research_pieces', input: { pieceNames: [branded] } }) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'reply' },
                { type: 'text-delta', id: 'reply', delta: 'Found the Gadget.' },
                { type: 'text-end', id: 'reply' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] }) }),
        })
        await runAgentTurn({
            model, provider: AIProviderName.OPENAI, modelId: 'gpt-4.1',
            systemPrompt: `Research Gadgets such as ${original}.`, messages: [{ role: 'user', content: 'Find Forms.' }],
            tools: { ap_research_pieces: tool({ description: `Research ${original}`, inputSchema: z.object({ pieceNames: z.array(z.string().describe(`For example ${original}`)) }), execute }) },
            allToolNames: ['ap_research_pieces'], tier: { id: 'smart', modelId: 'gpt-4.1', thinkingBudget: 0 }, phaseState: { phase: 'discovery' },
            abortSignal: new AbortController().signal, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            sinks: { drainStream: result => result.consumeStream() }, ...(mode === 'deferred' ? { skills: { surface: 'CHAT' as const, guides: {} } } : {}),
        })
        expect(execute).toHaveBeenCalledWith({ pieceNames: [original] }, expect.objectContaining({ toolCallId: 'research' }))
        expect(model.doStreamCalls.length).toBe(2)
        for (const call of model.doStreamCalls) {
            expect(JSON.stringify(call.prompt)).not.toContain(original)
            expect(JSON.stringify(call.tools)).not.toContain(original)
        }
        expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(branded)
    })
})
