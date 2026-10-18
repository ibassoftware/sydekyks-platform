import { AIProviderName } from '@activepieces/core-utils'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, ModelMessage, stepCountIs, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentProviderOptions } from '../src/agent-provider-options'

function providerOptions() {
    return agentProviderOptions.buildProviderOptions({ provider: AIProviderName.OPENAI, modelId: 'gpt-6-luna', tier: { id: 'fast', thinkingBudget: 0 } })
}

function responsesModel() {
    const requests: { store?: boolean, include?: string[], input: Record<string, unknown>[] }[] = []
    const model = createOpenAI({ apiKey: 'synthetic-test-key', fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body))
        requests.push(request)
        if (request.store !== false || request.input.some((item: Record<string, unknown>) => item.type === 'item_reference')) {
            return Response.json({ error: { message: 'Items are not persisted for Zero Data Retention organizations.', type: 'invalid_request_error' } }, { status: 400 })
        }
        const output = requests.length === 1 ? [
            { type: 'reasoning', id: 'rs_unsaved', summary: [], encrypted_content: 'encrypted-reasoning' },
            { type: 'function_call', id: 'fc_unsaved', call_id: 'call_create', name: 'create_agent', arguments: '{"name":"Greeting agent"}', status: 'completed' },
        ] : [{ type: 'message', role: 'assistant', id: 'msg_unsaved', status: 'completed', content: [{ type: 'output_text', text: 'Agent ready.', annotations: [] }] }]
        return Response.json({ id: `resp_${requests.length}`, model: 'gpt-6-luna', output, usage: { input_tokens: 5, output_tokens: 5 } })
    } }).responses('gpt-6-luna')
    return { model, requests }
}

describe('OpenAI agents with Zero Data Retention', () => {
    it('replays encrypted reasoning and tool results without looking up stored items, including on the next turn', async () => {
        const { model, requests } = responsesModel()
        const created: string[] = []
        const tools = { create_agent: tool({ inputSchema: z.object({ name: z.string() }), execute: async ({ name }) => {
            created.push(name)
            return { id: 'agent-1', name }
        } }) }
        const first = await generateText({ model, tools, messages: [{ role: 'user', content: 'Create a greeting agent.' }], providerOptions: providerOptions(), stopWhen: stepCountIs(3), maxRetries: 0 })
        expect(first.text).toBe('Agent ready.')
        expect(created).toEqual(['Greeting agent'])
        expect(requests[1].input).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-reasoning' }),
            expect.objectContaining({ type: 'function_call', call_id: 'call_create' }),
            expect.objectContaining({ type: 'function_call_output', call_id: 'call_create' }),
        ]))
        await generateText({ model, tools, messages: [{ role: 'user', content: 'Create a greeting agent.' }, ...first.response.messages, { role: 'user', content: 'What did you create?' }], providerOptions: providerOptions(), maxRetries: 0 })
        expect(requests).toHaveLength(3)
        for (const request of requests) {
            expect(request.store).toBe(false)
            expect(request.include).toContain('reasoning.encrypted_content')
            expect(request).not.toHaveProperty('previous_response_id')
            expect(request.input.some((item) => item.type === 'item_reference')).toBe(false)
        }
    })

    it('can resume an older conversation containing an unavailable reasoning ID without encrypted content', async () => {
        const { model, requests } = responsesModel()
        const messages: ModelMessage[] = [
            { role: 'assistant', content: [{ type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_old_unsaved' } } }, { type: 'text', text: 'I can help.' }] },
            { role: 'user', content: 'Continue.' },
        ]
        await generateText({ model, messages, providerOptions: providerOptions(), maxRetries: 0 })
        expect(requests[0].input).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rs_old_unsaved' })]))
        expect(JSON.stringify(requests[0].input)).toContain('I can help.')
    })
})
