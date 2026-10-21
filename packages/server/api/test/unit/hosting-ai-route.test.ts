import { AiRouterMatchMode } from '@activepieces/shared'
import { describe, expect, it } from 'vitest'
import { parseHostedAiRoute } from '../../src/app/hosting/hosting-ai-controller'

const options = { Billing: 'Payments', Technical: 'Bugs' }
describe('hosted AI router output boundary', () => {
    it('accepts exact routes and bounded confidence from the managed gateway answer', () => {
        expect(parseHostedAiRoute('{"matched":["Billing"],"probabilities":{"Billing":0.9}}', options, AiRouterMatchMode.BEST_MATCH)).toEqual({ matched: ['Billing'], probabilities: { Billing: 0.9 } })
        expect(parseHostedAiRoute('{"matched":["Billing","Technical"]}', options, AiRouterMatchMode.ALL_MATCHES)).toEqual({ matched: ['Billing', 'Technical'] })
    })
    it.each([
        '{"matched":["unknown"]}', '{"matched":["Billing","Billing"]}',
        '{"matched":[],"probabilities":{"Billing":1.1}}', '{"matched":[],"probabilities":{"unknown":0.5}}',
        '{"matched":[],"unexpected":true}', 'not JSON',
    ])('rejects malformed or unscoped supplier output: %s', answer => {
        expect(() => parseHostedAiRoute(answer, options, AiRouterMatchMode.BEST_MATCH)).toThrow('HOSTING_AI_ROUTE_INVALID')
    })
    it('limits best-match output to one route', () => {
        expect(() => parseHostedAiRoute('{"matched":["Billing","Technical"]}', options, AiRouterMatchMode.BEST_MATCH)).toThrow('HOSTING_AI_ROUTE_INVALID')
    })
})
