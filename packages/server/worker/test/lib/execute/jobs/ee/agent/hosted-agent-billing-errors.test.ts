import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { hostedAgentFailureMessage, hostedAgentRefusalOf } from '../../../../../../src/lib/execute/jobs/ee/agent/hosted-agent-model'

describe('hosted agent billing safeguards', () => {
    it('does not describe an unclassified service error as a customer Credit shortage', () => {
        const message = hostedAgentFailureMessage('Unclassified service failure')
        expect(message).toContain('service or provider error')
        expect(message).not.toContain('Check your available credits')
        expect(message).toContain('Earlier usage may still be charged')
    })
    it.each([
        ['HOSTING_CREDITS_EXHAUSTED', 'Not enough Credits'],
        ['HOSTING_RUN_CREDIT_LIMIT', 'safety limit'],
        ['HOSTING_AI_CALL_LIMIT', 'limit on AI calls'],
        ['HOSTING_NATIVE_CREDIT_LIMIT', 'safety limit'],
        ['HOSTING_NATIVE_TOOL_LIMIT', 'safety limit'],
        ['HOSTING_AI_FILE_UNAVAILABLE', 'Upload it again'],
        ['HOSTING_OPERATOR_BUDGET_EXHAUSTED', 'temporarily unavailable'],
        ['HOSTING_AI_OUTCOME_UNCERTAIN', 'Credits may remain held'],
    ])('explains %s without exposing internal supplier billing details', (code, expected) => {
        const message = hostedAgentFailureMessage(code)
        expect(message).toContain(expected)
        expect(message).not.toContain('HOSTING_')
        expect(message).not.toContain('DeepSeek')
    })
})

// Includes historical call-limit receipts from older gateway releases.
describe('trusted hosted gateway refusal classification including legacy receipts', () => {
    const base = 'http://127.0.0.1:1234/api/'
    const url = `${base}v1/engine/hosting-ai/copilot/chat/completions`
    const failure = (statusCode = 403, code = 'HOSTING_CREDITS_EXHAUSTED', target = url) => new APICallError({ message: 'Forbidden', url: target, requestBodyValues: {}, statusCode, responseBody: JSON.stringify({ code }), isRetryable: false })
    it('uses the verified code even when the SDK only says Forbidden', () => {
        expect(hostedAgentRefusalOf(failure(), base)).toEqual({ code: 'HOSTING_CREDITS_EXHAUSTED', message: expect.stringContaining('Not enough Credits') })
        expect(hostedAgentRefusalOf(new RetryError({ message: 'Failed', reason: 'errorNotRetryable', errors: [failure()] }), base)?.code).toBe('HOSTING_CREDITS_EXHAUSTED')
    })
    it.each([
        ['http://127.0.0.1:80/api/', 'http://127.0.0.1/api/v1/engine/hosting-ai/copilot/chat/completions'],
        ['https://internal.test:443/api/', 'https://internal.test/api/v1/engine/hosting-ai/copilot/completions'],
        ['http://127.0.0.1:1234/api/', 'http://127.0.0.1:1234/api/v1/engine/hosting-ai/copilot/chat/completions'],
    ])('pins the equivalent canonical gateway URL for %s', (internal, target) => {
        expect(hostedAgentRefusalOf(failure(403, 'HOSTING_AI_CALL_LIMIT', target), internal)).toEqual({ code: 'HOSTING_AI_CALL_LIMIT', message: 'This request reached the limit on AI calls. Start a new request with a smaller task.' })
    })
    it.each([
        'http://127.0.0.1:81/api/v1/engine/hosting-ai/copilot/chat/completions',
        'https://127.0.0.1/api/v1/engine/hosting-ai/copilot/chat/completions',
        'http://supplier.test/api/v1/engine/hosting-ai/copilot/chat/completions',
        'http://127.0.0.1/other/v1/engine/hosting-ai/copilot/chat/completions',
        'http://127.0.0.1/api/v1/engine/hosting-ai/copilot/chat/completions?source=supplier',
        'http://127.0.0.1/api/v1/engine/hosting-ai/copilot/chat/completions#receipt',
        'http://user@127.0.0.1/api/v1/engine/hosting-ai/copilot/chat/completions',
        'http://127.0.0.1/api/v1/engine/hosting-ai/copilot/chat/completions/extra',
        'not-a-url',
    ])('rejects a non-pinned or ambiguous gateway target %s', target => {
        expect(hostedAgentRefusalOf(failure(403, 'HOSTING_AI_CALL_LIMIT', target), 'http://127.0.0.1:80/api/')).toBeNull()
    })
    it('classifies only our exact internal Fastify 413 as a definitive pre-dispatch limit refusal', () => {
        expect(hostedAgentRefusalOf(failure(413, 'FST_ERR_CTP_BODY_TOO_LARGE'), base)).toEqual({ code: 'HOSTING_AI_REQUEST_LIMIT', message: expect.stringContaining('chat limits') })
        const directEndpoint = `${base}v1/engine/hosting-ai/copilot/completions`
        expect(hostedAgentRefusalOf(failure(413, 'FST_ERR_CTP_BODY_TOO_LARGE', directEndpoint), base)?.code).toBe('HOSTING_AI_REQUEST_LIMIT')
        const retry = new RetryError({ message: 'Failed', reason: 'errorNotRetryable', errors: [failure(413, 'FST_ERR_CTP_BODY_TOO_LARGE')] })
        expect(hostedAgentRefusalOf(retry, base)?.code).toBe('HOSTING_AI_REQUEST_LIMIT')
    })
    it.each([[413, 'HOSTING_AI_REQUEST_LIMIT'], [429, 'HOSTING_AI_RATE_LIMITED']])('accepts only a pinned pre-dispatch %s receipt', (statusCode, code) => {
        const responseBody = JSON.stringify({ code, receipt: { version: 1, phase: 'pre_dispatch' } })
        const error = new APICallError({ message: 'Request rejected', url: `${base}v1/engine/hosting-ai/copilot/completions`, requestBodyValues: {}, statusCode, responseBody, isRetryable: false })
        expect(hostedAgentRefusalOf(error, base)?.code).toBe(code)
        for (const receipt of [undefined, { version: 2, phase: 'pre_dispatch' }, { version: 1, phase: 'supplier' }, null]) {
            expect(hostedAgentRefusalOf(new APICallError({ message: 'Rejected', url, requestBodyValues: {}, statusCode, responseBody: JSON.stringify({ code, receipt }), isRetryable: false }), base)).toBeNull()
        }
        expect(hostedAgentRefusalOf(new APICallError({ message: 'Rejected', url: 'https://supplier.test/chat/completions', requestBodyValues: {}, statusCode, responseBody, isRetryable: false }), base)).toBeNull()
    })
    it('never trusts supplier 413s, arbitrary 413 messages, wrong codes or malformed bodies', () => {
        expect(hostedAgentRefusalOf(failure(413, 'FST_ERR_CTP_BODY_TOO_LARGE', 'https://supplier.test/chat/completions'), base)).toBeNull()
        expect(hostedAgentRefusalOf(failure(413, 'HOSTING_AI_REQUEST_LIMIT'), base)).toBeNull()
        expect(hostedAgentRefusalOf(failure(413, 'UNKNOWN'), base)).toBeNull()
        expect(hostedAgentRefusalOf(failure(403, 'FST_ERR_CTP_BODY_TOO_LARGE'), base)).toBeNull()
        expect(hostedAgentRefusalOf(new Error('FST_ERR_CTP_BODY_TOO_LARGE'), base)).toBeNull()
        for (const responseBody of ['not-json', 'null', '[]', JSON.stringify('FST_ERR_CTP_BODY_TOO_LARGE'), JSON.stringify({ message: 'Payload Too Large' })]) {
            const error = new APICallError({ message: 'Payload Too Large', url, requestBodyValues: {}, statusCode: 413, responseBody, isRetryable: false })
            expect(hostedAgentRefusalOf(error, base)).toBeNull()
        }
    })
    it.each(['not-json', 'null', '[]', JSON.stringify('HOSTING_AI_CALL_LIMIT'), JSON.stringify({ message: 'Forbidden' }), JSON.stringify({ code: 403 }), JSON.stringify({ code: 'UNKNOWN' })])('keeps an opaque or ambiguous internal 403 unknown: %s', responseBody => {
        const error = new APICallError({ message: 'Forbidden', url, requestBodyValues: {}, statusCode: 403, responseBody, isRetryable: false })
        expect(hostedAgentRefusalOf(error, base)).toBeNull()
    })
    it('never classifies unknown, non-403 or external-provider errors as definitive hosted refusals', () => {
        expect(hostedAgentRefusalOf(failure(403, 'HOSTING_AI_OUTCOME_UNCERTAIN'), base)).toBeNull()
        expect(hostedAgentRefusalOf(failure(429), base)).toBeNull()
        expect(hostedAgentRefusalOf(failure(403, 'HOSTING_CREDITS_EXHAUSTED', 'https://supplier.test/chat/completions'), base)).toBeNull()
        expect(hostedAgentRefusalOf(new Error('HOSTING_CREDITS_EXHAUSTED'), base)).toBeNull()
    })
})
