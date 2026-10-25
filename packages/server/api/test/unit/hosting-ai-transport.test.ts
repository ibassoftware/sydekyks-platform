import RateLimit from '@fastify/rate-limit'
import { APICallError, generateText, streamText } from 'ai'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHostedAgentModel, hostedAgentRefusalOf } from '../../../worker/src/lib/execute/jobs/ee/agent/hosted-agent-model'
import { entitiesMustBeOwnedByCurrentProject } from '../../src/app/authentication/authorization'
import type { JobContext } from '../../../worker/src/lib/execute/types'
import { HostingError } from '../../src/app/hosting/hosting-transactions'
import { hostedAiRateLimit, hostingAiController } from '../../src/app/hosting/hosting-ai-controller'
import { HOSTED_AI_CONTEXT_TOKENS, HOSTED_AI_REQUEST_MAX_BYTES, hostedAiInputBound, HostedAiRequest } from '../../src/app/hosting/hosting-ai-policy'

const { execute, stream, assertModel } = vi.hoisted(() => ({ execute: vi.fn(async (_input: unknown) => ({ accepted: true })), stream: vi.fn(), assertModel: vi.fn(async () => undefined) }))
vi.mock('../../src/app/hosting/hosting-copilot', () => ({ assertHostedCopilotModel: assertModel }))
vi.mock('../../src/app/hosting/hosting-services', () => ({ hostingServices: { gateway: () => ({ execute, stream }) } }))

let app: FastifyInstance
const path = '/api/v1/engine/hosting-ai/copilot/completions'
const input = { callKey: 'copilot:0', payer: { type: 'managed' }, model: 'sydekyks', messages: [{ role: 'user', content: 'Build a lead intake Mission.' }], max_tokens: 4096 }
const headers = (project = 'a'.repeat(21)) => ({ 'content-type': 'application/json', 'x-test-project': project })
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    app = fastify()
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
    // The real engine parent hook runs even for parser errors, before auth has
    // populated a principal. Fixed transport receipts must not traverse entity
    // ownership serialization; normal gateway objects must still traverse it.
    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)
    // Production authentication runs in a parent preHandler before route-level
    // rate limiting. Supply the same trusted principal shape, never body/IP keys.
    app.addHook('preHandler', async request => {
        request.principal = { type: 'ENGINE', id: 'b'.repeat(21), platform: { id: 'c'.repeat(21) }, projectId: request.headers['x-test-project'] as string } as typeof request.principal
    })
    await app.register(RateLimit, { global: false })
    await app.register(hostingAiController, { prefix: '/api/v1/engine/hosting-ai' })
    await app.ready()
})
afterAll(async () => {
    await app.close(); vi.unstubAllEnvs()
})

describe('real hosted AI HTTP parser, serializer and rate admission', () => {
    it('accepts full tool schemas and continuation history beyond the old 64 KiB envelope', async () => {
        const tools = Array.from({ length: 36 }, (_, index) => ({ type: 'function', function: { name: `catalogue_${index}`, description: 'Catalogue Gadget input.', parameters: { type: 'object', properties: { value: { type: 'string', description: 'x'.repeat(1800) } }, required: ['value'], additionalProperties: false } } }))
        const payload = { ...input, tools, messages: [...input.messages, { role: 'assistant', content: 'x'.repeat(20000) }, { role: 'user', content: 'Keep those fields and continue.' }] }
        const encoded = JSON.stringify(payload)
        expect(Buffer.byteLength(encoded)).toBeGreaterThan(65536)
        const parsed = HostedAiRequest.parse(payload)
        expect(hostedAiInputBound(parsed) + parsed.max_tokens).toBeLessThan(HOSTED_AI_CONTEXT_TOKENS)
        const response = await app.inject({ method: 'POST', url: path, headers: headers(), payload: encoded })
        expect(response.statusCode).toBe(200)
        expect(execute.mock.lastCall?.[0]).toMatchObject({ request: { tools, messages: payload.messages } })
    })
    it('keeps normal gateway objects subject to the real engine ownership hook', async () => {
        execute.mockImplementationOnce(async () => ({ accepted: true, projectId: 'f'.repeat(21) }))
        const response = await app.inject({ method: 'POST', url: path, headers: headers(), payload: input })
        expect(response.statusCode).toBe(403)
        expect(response.json().code).toBe('AUTHORIZATION')
    })
    it.each([false, true])('preserves a call-limit refusal through Fastify and the AI SDK (stream=%s)', async streaming => {
        const gatewayCall = streaming ? stream : execute
        gatewayCall.mockRejectedValueOnce(new HostingError('HOSTING_AI_CALL_LIMIT'))
        const response = await app.inject({ method: 'POST', url: path, headers: headers(), payload: { ...input, stream: streaming } })
        expect(response.statusCode).toBe(403)
        expect(response.json()).toEqual({ code: 'HOSTING_AI_CALL_LIMIT' })
        const originalFetch = globalThis.fetch
        vi.stubGlobal('fetch', async () => new Response(response.body, { status: response.statusCode, statusText: response.statusMessage, headers: response.headers as HeadersInit }))
        try {
            const internalApiUrl = 'http://127.0.0.1:80/api/'
            const model = createHostedAgentModel({ ctx: { admissionId: 'synthetic-admission', engineToken: 'synthetic-engine-token', internalApiUrl } as JobContext, config: { protocol: 1, payer: { type: 'managed' }, model: 'sydekyks' } })
            let failure: unknown
            if (streaming) {
                const result = streamText({ model, prompt: 'Continue', maxRetries: 0, onError: ({ error }) => { failure = error } })
                await result.consumeStream()
            }
            else failure = await generateText({ model, prompt: 'Continue', maxRetries: 0 }).then(() => null, error => error)
            expect(APICallError.isInstance(failure)).toBe(true)
            expect((failure as APICallError).statusCode).toBe(403)
            expect((failure as APICallError).responseBody).toBe(response.body)
            expect((failure as APICallError).url).toBe('http://127.0.0.1/api/v1/engine/hosting-ai/copilot/chat/completions')
            expect(hostedAgentRefusalOf(failure, internalApiUrl)?.code).toBe('HOSTING_AI_CALL_LIMIT')
        }
        finally {
            vi.stubGlobal('fetch', originalFetch)
        }
    })
    it('serializes an exact pre-dispatch receipt for oversized bytes and never invokes the gateway', async () => {
        const calls = execute.mock.calls.length
        const response = await app.inject({ method: 'POST', url: path, headers: headers(), payload: JSON.stringify({ ...input, padding: 'x'.repeat(HOSTED_AI_REQUEST_MAX_BYTES) }) })
        expect(response.statusCode).toBe(413)
        expect(response.json()).toEqual({ code: 'HOSTING_AI_REQUEST_LIMIT', receipt: { version: 1, phase: 'pre_dispatch' } })
        expect(execute).toHaveBeenCalledTimes(calls)
        expect(hostedAgentRefusalOf(new APICallError({ message: response.statusMessage, url: `http://internal${path}`, requestBodyValues: {}, statusCode: response.statusCode, responseBody: response.body, isRetryable: false }), 'http://internal/api')?.code).toBe('HOSTING_AI_REQUEST_LIMIT')
    })
    it('admits a full 32-call builder root, bounds a tenant burst, and isolates tenants sharing one worker IP', async () => {
        const project = 'd'.repeat(21)
        for (let index = 0; index < Number(hostedAiRateLimit.max); index++) {
            const response = await app.inject({ method: 'POST', url: path, headers: headers(project), payload: { ...input, callKey: `copilot:${index}` } })
            expect(response.statusCode).toBe(200)
        }
        const calls = execute.mock.calls.length
        const refused = await app.inject({ method: 'POST', url: path, headers: headers(project), payload: input })
        expect(refused.statusCode).toBe(429)
        expect(refused.json()).toEqual({ code: 'HOSTING_AI_RATE_LIMITED', receipt: { version: 1, phase: 'pre_dispatch' } })
        expect(hostedAgentRefusalOf(new APICallError({ message: refused.statusMessage, url: `http://internal${path}`, requestBodyValues: {}, statusCode: refused.statusCode, responseBody: refused.body, isRetryable: false }), 'http://internal/api')?.code).toBe('HOSTING_AI_RATE_LIMITED')
        expect(execute).toHaveBeenCalledTimes(calls)
        const other = await app.inject({ method: 'POST', url: path, headers: headers('e'.repeat(21)), payload: input })
        expect(other.statusCode).toBe(200)
    })
})
