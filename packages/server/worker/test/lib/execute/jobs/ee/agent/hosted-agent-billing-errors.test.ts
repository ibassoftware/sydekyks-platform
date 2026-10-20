import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { hostedAgentFailureMessage, hostedAgentRefusalOf } from '../../../../../../src/lib/execute/jobs/ee/agent/hosted-agent-model'

describe('hosted agent billing safeguards', () => {
    it.each([
        ['HOSTING_CREDITS_EXHAUSTED', 'Not enough Credits'],
        ['HOSTING_RUN_CREDIT_LIMIT', 'safety limit'],
        ['HOSTING_AI_CALL_LIMIT', 'safety limit'],
        ['HOSTING_OPERATOR_BUDGET_EXHAUSTED', 'temporarily unavailable'],
        ['HOSTING_AI_OUTCOME_UNCERTAIN', 'Credits may remain held'],
    ])('explains %s without exposing internal supplier billing details', (code, expected) => {
        const message = hostedAgentFailureMessage(code)
        expect(message).toContain(expected)
        expect(message).not.toContain('HOSTING_')
        expect(message).not.toContain('DeepSeek')
    })
})

describe('trusted hosted gateway refusal classification', () => {
    const base = 'http://127.0.0.1:1234/api/'
    const url = `${base}v1/engine/hosting-ai/copilot/chat/completions`
    const failure = (statusCode = 403, code = 'HOSTING_CREDITS_EXHAUSTED', target = url) => new APICallError({ message: 'Forbidden', url: target, requestBodyValues: {}, statusCode, responseBody: JSON.stringify({ code }), isRetryable: false })
    it('uses the verified code even when the SDK only says Forbidden', () => {
        expect(hostedAgentRefusalOf(failure(), base)).toEqual({ code: 'HOSTING_CREDITS_EXHAUSTED', message: expect.stringContaining('Not enough Credits') })
        expect(hostedAgentRefusalOf(new RetryError({ message: 'Failed', reason: 'errorNotRetryable', errors: [failure()] }), base)?.code).toBe('HOSTING_CREDITS_EXHAUSTED')
    })
    it('never classifies unknown, non-403 or external-provider errors as definitive hosted refusals', () => {
        expect(hostedAgentRefusalOf(failure(403, 'HOSTING_AI_OUTCOME_UNCERTAIN'), base)).toBeNull()
        expect(hostedAgentRefusalOf(failure(429), base)).toBeNull()
        expect(hostedAgentRefusalOf(failure(403, 'HOSTING_CREDITS_EXHAUSTED', 'https://supplier.test/chat/completions'), base)).toBeNull()
        expect(hostedAgentRefusalOf(new Error('HOSTING_CREDITS_EXHAUSTED'), base)).toBeNull()
    })
})
