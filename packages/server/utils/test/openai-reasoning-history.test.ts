import { AIProviderName } from '@activepieces/core-utils'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, jsonSchema, ModelMessage, modelMessageSchema, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { agentAiUtils } from '../src/agent-ai-utils'

describe('OpenAI Responses history replay', () => {
    it.each(['text', 'tool-call'])('preserves reasoning linked to a %s after persistence and history preparation', async (kind) => {
        const requests: unknown[] = []
        const provider = createOpenAI({
            apiKey: 'test-key',
            fetch: async (_input, init) => {
                requests.push(JSON.parse(String(init?.body)))
                const firstOutput = kind === 'text'
                    ? { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Inspecting the flow', annotations: [] }] }
                    : { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'inspect', arguments: '{}', status: 'completed' }
                const output = requests.length === 1
                    ? [{ type: 'reasoning', id: 'rs_1', summary: [] }, firstOutput]
                    : [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }]
                return new Response(JSON.stringify({ id: `resp_${requests.length}`, created_at: 0, model: 'gpt-6-luna', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { headers: { 'Content-Type': 'application/json' } })
            },
        })
        const model = provider.responses('gpt-6-luna')
        const tools = { inspect: tool({ description: 'Inspect the flow', inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }) }) }
        const first = await generateText({ model, messages: [{ role: 'user', content: 'Inspect' }], tools })
        const persisted = first.response.messages.map((message) => modelMessageSchema.parse(JSON.parse(JSON.stringify(message))))
        const continuation: ModelMessage = kind === 'text'
            ? { role: 'user', content: 'Continue' }
            : { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'inspect', output: { type: 'json', value: { valid: true } } }] }
        const history = agentAiUtils.stripThinkingBlocks([...persisted, continuation], AIProviderName.OPENAI)
        const final = await generateText({ model, messages: history, tools })
        expect(final.text).toBe('Done')
        expect(requests[1]).toMatchObject({ input: expect.arrayContaining([{ type: 'item_reference', id: 'rs_1' }]) })
        expect(requests[1]).toMatchObject({ input: expect.arrayContaining(kind === 'text'
            ? [{ type: 'item_reference', id: 'msg_1' }]
            : [{ type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_1', output: '{"valid":true}' }].map((item) => expect.objectContaining(item))) })
    })
})
