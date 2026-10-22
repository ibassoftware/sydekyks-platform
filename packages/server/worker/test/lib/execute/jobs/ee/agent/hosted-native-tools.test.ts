import { createHash } from 'node:crypto'
import { AgentConfigResponse } from '@activepieces/shared'
import { generateText, isStepCount, tool, ToolExecutionOptions } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { compactHostedNativeToolSchema, createHostedAgentModel, createHostedNativeWebTools } from '../../../../../../src/lib/execute/jobs/ee/agent/hosted-agent-model'
import { createDisplayTools } from '../../../../../../src/lib/execute/jobs/ee/agent/tools/display-tools'
import { JobContext } from '../../../../../../src/lib/execute/types'

const ctx = { admissionId: 'admitted', internalApiUrl: 'http://127.0.0.1:1234/api/', engineToken: 'exact-dispatch-token' } as JobContext
const config: NonNullable<AgentConfigResponse['hosted']> = { protocol: 1, model: 'sydekyks', payer: { type: 'managed' }, nativeWebSearch: true, nativeFileIds: ['abcdefghijklmnopqrstu'] }
const options = { toolCallId: 'tool-call-1', messages: [] } as ToolExecutionOptions
afterEach(() => vi.unstubAllGlobals())

describe('admitted native web tools', () => {
    it('exposes only the metered search and page tools when this turn opted in', () => {
        expect(Object.keys(createHostedNativeWebTools({ ctx, config, taintState: { tainted: false } }))).toEqual(['ap_search_web', 'ap_read_web_page'])
        expect(createHostedNativeWebTools({ ctx, config: { ...config, nativeWebSearch: false }, taintState: { tainted: false } })).toEqual({})
    })
    it('matches the gateway search bound before any supplier request', () => {
        const tools = createHostedNativeWebTools({ ctx, config, taintState: { tainted: false } })
        const schema = tools.ap_search_web.inputSchema as z.ZodType
        expect(schema.safeParse({ query: 'q'.repeat(128) }).success).toBe(true)
        expect(schema.safeParse({ query: 'q'.repeat(129) }).success).toBe(false)
        expect(schema.safeParse({ query: '  ' }).success).toBe(false)
    })
    it('pins payer and model, uses the exact dispatch token and hashes the tool call identity', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ kind: 'search', results: [{ title: 'Source', url: 'https://example.com', snippet: 'Fact' }] })))
        vi.stubGlobal('fetch', fetch)
        const taintState = { tainted: false }
        const tools = createHostedNativeWebTools({ ctx, config, taintState })
        await tools.ap_search_web.execute!({ query: 'current information' }, options)
        expect(fetch).toHaveBeenCalledTimes(1)
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('http://127.0.0.1:1234/api/v1/engine/hosting-ai/tools')
        expect(init.headers).toMatchObject({ Authorization: 'Bearer exact-dispatch-token' })
        expect(JSON.parse(init.body as string)).toEqual({ callKey: `native:${createHash('sha256').update('tool-call-1').digest('hex')}`, attempt: 0, payer: { type: 'managed' }, model: 'sydekyks', kind: 'search', query: 'current information' })
        expect(taintState.tainted).toBe(true)
    })
    it('uses the selected BYOK payer and never retries an ambiguous send', async () => {
        const fetch = vi.fn(async () => { throw new Error('connection lost') })
        vi.stubGlobal('fetch', fetch)
        const tools = createHostedNativeWebTools({ ctx, config: { ...config, model: 'deepseek-flash', payer: { type: 'byok', configId: 'chosen-key' } }, taintState: { tainted: false } })
        await expect(tools.ap_read_web_page.execute!({ url: 'https://example.com' }, options)).rejects.toThrow('HOSTING_AI_OUTCOME_UNCERTAIN')
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).payer).toEqual({ type: 'byok', configId: 'chosen-key' })
    })
    it('forwards a safe gateway refusal without supplier text or a second send', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'HOSTING_CREDITS_EXHAUSTED', message: 'private supplier details' }), { status: 403 }))
        vi.stubGlobal('fetch', fetch)
        const tools = createHostedNativeWebTools({ ctx, config, taintState: { tainted: false } })
        await expect(tools.ap_search_web.execute!({ query: 'test' }, options)).rejects.toThrow(/^HOSTING_CREDITS_EXHAUSTED$/)
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it('serializes concurrent search and page calls behind the first accounting result', async () => {
        let release!: () => void
        const firstRequest = new Promise<void>(resolve => { release = resolve })
        let count = 0
        const fetch = vi.fn(async () => {
            if (++count === 1) await firstRequest
            return new Response(JSON.stringify({ kind: count === 1 ? 'search' : 'fetch', results: [] }))
        })
        vi.stubGlobal('fetch', fetch)
        const tools = createHostedNativeWebTools({ ctx, config, taintState: { tainted: false } })
        const first = tools.ap_search_web.execute!({ query: 'test' }, options)
        const second = tools.ap_read_web_page.execute!({ url: 'https://example.com' }, { ...options, toolCallId: 'tool-call-2' })
        const completed = Promise.allSettled([first, second])
        await Promise.resolve()
        expect(fetch).toHaveBeenCalledTimes(1)
        release()
        expect((await completed).map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(fetch).toHaveBeenCalledTimes(2)
        const requests = fetch.mock.calls as unknown as [string, RequestInit][]
        expect(requests.map(([, init]) => JSON.parse(init.body as string).kind)).toEqual(['search', 'fetch'])
        expect(JSON.parse(requests[1][1].body as string).callKey).toBe(`native:${createHash('sha256').update('tool-call-2').digest('hex')}`)
    })
    it('latches an ambiguous first send and refuses queued calls without sending them', async () => {
        let release!: () => void
        const firstRequest = new Promise<void>(resolve => { release = resolve })
        const fetch = vi.fn(async () => { await firstRequest; throw new Error('connection lost') })
        vi.stubGlobal('fetch', fetch)
        const tools = createHostedNativeWebTools({ ctx, config, taintState: { tainted: false } })
        const first = tools.ap_search_web.execute!({ query: 'test' }, options)
        const second = tools.ap_read_web_page.execute!({ url: 'https://example.com' }, { ...options, toolCallId: 'tool-call-2' })
        const completed = Promise.allSettled([first, second])
        await Promise.resolve()
        expect(fetch).toHaveBeenCalledTimes(1)
        release()
        const results = await completed
        expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
        expect(results.map(result => result.status === 'rejected' ? result.reason.message : '')).toEqual(['HOSTING_AI_OUTCOME_UNCERTAIN', 'HOSTING_AI_OUTCOME_UNCERTAIN'])
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it('does not dispatch a queued call after the turn is cancelled', async () => {
        let release!: () => void
        const firstRequest = new Promise<void>(resolve => { release = resolve })
        const fetch = vi.fn(async () => { await firstRequest; return new Response(JSON.stringify({ kind: 'search', results: [] })) })
        vi.stubGlobal('fetch', fetch)
        const controller = new AbortController()
        const tools = createHostedNativeWebTools({ ctx, config, taintState: { tainted: false }, abortSignal: controller.signal })
        const first = tools.ap_search_web.execute!({ query: 'test' }, options)
        const second = tools.ap_read_web_page.execute!({ url: 'https://example.com' }, { ...options, toolCallId: 'tool-call-2' })
        const completed = Promise.allSettled([first, second])
        await Promise.resolve()
        controller.abort()
        release()
        const results = await completed
        expect(results[0].status).toBe('fulfilled')
        expect(results[1].status).toBe('rejected')
        expect(results[1].status === 'rejected' && results[1].reason.message).toBe('HOSTING_AI_SEGMENT_DENIED')
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it('passes pinned attachment IDs separately and bounds native output to 2048', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'reply', object: 'chat.completion', created: 1, model: 'sydekyks', choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetch)
        await generateText({ model: createHostedAgentModel({ ctx, config }), prompt: 'Read the attachment.', maxOutputTokens: 4096, maxRetries: 0 })
        const payload = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
        expect(payload.fileIds).toEqual(config.nativeFileIds)
        expect(payload.max_tokens).toBe(2048)
        expect(payload.attempt).toBe(0)
    })
})


describe('native tool schema wire compaction', () => {
    it('removes annotations only at schema positions and preserves validation and business data', () => {
        const data = { description: 'business description', title: 'business title', examples: ['business examples'], $comment: 'business comment' }
        const schema = {
            description: 'annotation', title: 'annotation', examples: [data], $comment: 'annotation',
            type: 'object', required: ['description'], additionalProperties: false,
            properties: {
                description: { description: 'annotation', title: 'annotation', type: 'string', minLength: 2, maxLength: 20, enum: ['description', 'title'] },
                payload: { const: data, default: data },
            },
            $defs: { description: { description: 'annotation', type: 'string', pattern: '^x' } },
            definitions: { title: { title: 'annotation', type: 'integer', minimum: 1 } },
            patternProperties: { '^description$': { description: 'annotation', type: 'boolean' } },
            dependentSchemas: { description: { description: 'annotation', required: ['payload'] } },
            dependencies: { payload: ['description'], description: { description: 'annotation', minProperties: 1 } },
            dependentRequired: { description: ['payload'] },
            items: { description: 'annotation', type: 'number', maximum: 10 },
            allOf: [{ description: 'annotation', required: ['description'] }],
            anyOf: [{ title: 'annotation', const: data }],
            oneOf: [{ examples: [data], enum: [data] }],
            prefixItems: [{ $comment: 'annotation', type: 'string' }],
            not: { description: 'annotation', type: 'null' },
            if: { description: 'annotation', required: ['payload'] },
            then: { description: 'annotation', maxProperties: 2 },
            else: { description: 'annotation', minProperties: 1 },
            contains: { description: 'annotation', const: data },
            unevaluatedProperties: { description: 'annotation', type: 'string' },
            'x-business-data': data,
        }
        const result = compactHostedNativeToolSchema(schema)
        expect(result).toEqual({
            type: 'object', required: ['description'], additionalProperties: false,
            properties: { description: { type: 'string', minLength: 2, maxLength: 20, enum: ['description', 'title'] }, payload: { const: data, default: data } },
            $defs: { description: { type: 'string', pattern: '^x' } },
            definitions: { title: { type: 'integer', minimum: 1 } },
            patternProperties: { '^description$': { type: 'boolean' } },
            dependentSchemas: { description: { required: ['payload'] } },
            dependencies: { payload: ['description'], description: { minProperties: 1 } },
            dependentRequired: { description: ['payload'] },
            items: { type: 'number', maximum: 10 }, allOf: [{ required: ['description'] }],
            anyOf: [{ const: data }], oneOf: [{ enum: [data] }], prefixItems: [{ type: 'string' }],
            not: { type: 'null' }, if: { required: ['payload'] }, then: { maxProperties: 2 }, else: { minProperties: 1 },
            contains: { const: data }, unevaluatedProperties: { type: 'string' }, 'x-business-data': data,
        })
        expect(schema.properties.description.description).toBe('annotation')
        expect(compactHostedNativeToolSchema(false)).toBe(false)
    })
    it('compacts native outbound wire only while leaving the full local SDK schema and ordinary wire intact', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'reply', object: 'chat.completion', created: 1, model: 'sydekyks', choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetch)
        const description = 'Inspect the requested content. ' + 'Extra tool guidance. '.repeat(100)
        const inputSchema = z.object({ description: z.string().min(2).max(20).describe('Long property annotation. '.repeat(100)) })
        const tools = { inspect: tool({ description, inputSchema }) }
        for (const selected of [config, { ...config, nativeWebSearch: false, nativeFileIds: [] }]) {
            await generateText({ model: createHostedAgentModel({ ctx, config: selected }), prompt: 'Read.', tools, maxRetries: 0 })
        }
        const requests = fetch.mock.calls as unknown as [string, RequestInit][]
        const native = JSON.parse(requests[0][1].body as string).tools[0].function
        const ordinary = JSON.parse(requests[1][1].body as string).tools[0].function
        expect(native.description).toBe('Inspect the requested content.')
        expect(native.parameters.properties.description).toMatchObject({ type: 'string', minLength: 2, maxLength: 20 })
        expect(native.parameters.properties.description).not.toHaveProperty('description')
        expect(native.parameters.required).toContain('description')
        expect(ordinary.description).toBe(description)
        expect(ordinary.parameters.properties.description.description).toBe(inputSchema.shape.description.description)
        expect(inputSchema.shape.description.safeParse('x').success).toBe(false)
        expect(inputSchema.shape.description.description).toContain('Long property annotation.')
        expect(JSON.stringify(native).length).toBeLessThan(JSON.stringify(ordinary).length / 2)
    })
    it('compacts ordinary presentation metadata while retaining all tools, consent guidance, business parameter instructions and message history', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'reply', object: 'chat.completion', created: 1, model: 'sydekyks', choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetch)
        const displayTools = createDisplayTools({ waitForApproval: async () => ({ outcome: 'approved' }), displayToolTimeoutMs: 1 })
        const businessDescription = 'Send only after explicit user approval. All standing safety instructions remain mandatory.'
        const parameterGuidance = 'Use the exact validated tenant customer identifier; never infer it from a display name.'
        const business = tool({ description: businessDescription, inputSchema: z.object({ description: z.string().min(2).max(80).describe(parameterGuidance) }) })
        const tools = { ...displayTools, send_customer_notice: business }
        const messages = [{ role: 'user' as const, content: 'Earlier context stays intact.' }, { role: 'assistant' as const, content: 'Previous answer.' }, { role: 'user' as const, content: 'Show the choices.' }]
        await generateText({ model: createHostedAgentModel({ ctx, config: { ...config, nativeWebSearch: false, nativeFileIds: [] } }), messages, tools, maxRetries: 0 })
        const payload = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
        expect(payload.tools.map((entry: { function: { name: string } }) => entry.function.name)).toEqual(Object.keys(tools))
        const byName = Object.fromEntries(payload.tools.map((entry: { function: { name: string } }) => [entry.function.name, entry.function]))
        expect(byName.ap_show_questions.description).toBe(displayTools.ap_show_questions.description)
        expect(byName.ap_show_showcase.description).toBe(displayTools.ap_show_showcase.description)
        expect(JSON.stringify(byName.ap_show_questions.parameters)).not.toContain('Allowed names:')
        const questions = byName.ap_show_questions.parameters.properties.questions
        const variants = questions.items.oneOf ?? questions.items.anyOf
        expect(questions).toMatchObject({ type: 'array', minItems: 1 })
        expect(variants).toHaveLength(7)
        const byType = Object.fromEntries(variants.map((variant: { properties: { type: { const?: string, enum?: string[] } } }) => [variant.properties.type.const ?? variant.properties.type.enum?.[0], variant]))
        expect(Object.keys(byType).sort()).toEqual(['choice', 'color', 'date', 'date_range', 'multi_choice', 'slider', 'time'])
        expect(byType.choice.required).toEqual(expect.arrayContaining(['type', 'question', 'options']))
        expect(byType.choice.properties.options.minItems).toBe(2)
        expect(byType.multi_choice.properties.options.minItems).toBe(2)
        expect(byType.slider.required).toEqual(expect.arrayContaining(['type', 'question', 'min', 'max']))
        expect(byName.ap_show_questions.parameters.required).toContain('questions')
        expect(byName.ap_show_connection_picker.description).toBe(displayTools.ap_show_connection_picker.description)
        expect(byName.ap_show_connection_picker.parameters.properties.switchAccount.description).toContain('different account')
        expect(byName.send_customer_notice.description).toBe(businessDescription)
        expect(byName.send_customer_notice.parameters.properties.description).toMatchObject({ description: parameterGuidance, type: 'string', minLength: 2, maxLength: 80 })
        expect(payload.messages).toEqual(messages)
    })
    it('still validates and executes a complete real question-tool call with ordinary hosted compact wire', async () => {
        const question = { questions: [{ type: 'choice', question: 'Which format?', options: [{ label: 'Summary' }, { label: 'Details' }] }] }
        const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'reply', object: 'chat.completion', created: 1, model: 'sydekyks', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'question-call', type: 'function', function: { name: 'ap_show_questions', arguments: JSON.stringify(question) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetch)
        const waitForApproval = vi.fn(async () => ({ outcome: 'approved' as const, payload: { answer: 'Summary' } }))
        const tools = createDisplayTools({ waitForApproval, displayToolTimeoutMs: 1 })
        const result = await generateText({ model: createHostedAgentModel({ ctx, config: { ...config, nativeWebSearch: false, nativeFileIds: [] } }), prompt: 'Ask me which format.', tools, maxRetries: 0, stopWhen: isStepCount(1) })
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(waitForApproval).toHaveBeenCalledWith({ gateId: 'question-call', timeoutMs: 1 })
        expect(result.toolResults).toHaveLength(1)
        expect(result.toolResults[0].toolName).toBe('ap_show_questions')
        expect(result.toolResults[0].output).toMatchObject({ answered: true, answer: 'Summary' })
    })

})
