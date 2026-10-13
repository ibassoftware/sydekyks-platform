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
