import { AIProviderName } from '@activepieces/core-utils'
import { LanguageModelV4StreamPart, SharedV3ProviderOptions } from '@ai-sdk/provider'
import { tool } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runAgentTurn } from '../../../../../../src/lib/execute/jobs/ee/agent/run-agent-turn'

describe('OpenAI retention options in the agent worker', () => {
    it('uses stateless requests on every step of a tool-using turn', async () => {
        const sent: SharedV3ProviderOptions[] = []
        const model = new MockLanguageModelV4({ doStream: async ({ providerOptions }) => {
            sent.push(providerOptions ?? {})
            const parts: LanguageModelV4StreamPart[] = sent.length === 1
                ? [{ type: 'tool-call', toolCallId: 'create-1', toolName: 'ap_create_agent', input: '{"name":"Greeting"}' }]
                : [{ type: 'text-start', id: 'done' }, { type: 'text-delta', id: 'done', delta: 'Created.' }, { type: 'text-end', id: 'done' }]
            return { stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                { type: 'stream-start', warnings: [] }, ...parts,
                { type: 'finish', finishReason: { unified: sent.length === 1 ? 'tool-calls' : 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } } },
            ]) }
        } })
        const result = await runAgentTurn({
            model, provider: AIProviderName.OPENAI, modelId: 'gpt-6-luna',
            systemPrompt: 'Create an agent using the provided tool.', messages: [{ role: 'user', content: 'Create Greeting.' }],
            tools: { ap_create_agent: tool({ inputSchema: z.object({ name: z.string() }), execute: async () => ({ id: 'agent-1' }) }) },
            allToolNames: ['ap_create_agent'], tier: { id: 'fast', thinkingBudget: 0, modelId: 'gpt-6-luna' },
            phaseState: { phase: 'build' }, abortSignal: new AbortController().signal,
            log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, creditsLeft: async () => 100,
        })
        expect(result.streamError).toBeNull()
        expect(sent).toHaveLength(2)
        for (const options of sent) expect(options.openai).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] })
    })
})
