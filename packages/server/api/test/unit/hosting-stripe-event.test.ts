import { describe, expect, it } from 'vitest'
import { assertStripeEventEnvelope } from '../../src/app/hosting/hosting-stripe-event'

const event = () => ({ id: 'evt_testEvent', type: 'invoice.paid', created: 1770000000, livemode: false, api_version: '2020-08-27', data: { object: { id: 'in_testInvoice', object: 'invoice', customer: 'cus_testCustomer' } } })
describe('supported signed Stripe routing envelopes', () => {
    it('accepts explicit legacy and pinned Basil routing contracts', () => {
        expect(() => assertStripeEventEnvelope(event())).not.toThrow()
        expect(() => assertStripeEventEnvelope({ ...event(), api_version: '2025-05-28.basil' })).not.toThrow()
    })
    it.each([{ api_version: '2026-09-30.clover' }, { api_version: null }, { livemode: true }, { account: 'acct_connected' }, { context: 'acct_other' }, { id: 'in_wrong' }, { created: -1 }])('rejects unsupported context %o', patch => {
        expect(() => assertStripeEventEnvelope({ ...event(), ...patch })).toThrow('EVENT_CONTEXT_DENIED')
    })
    it.each([{ id: 'ch_wrongKind' }, { object: 'charge' }, { customer: 'cus_wrong/slash' }, { customer: { id: 'acct_wrong' } }, { charge: 'cus_wrong' }])('rejects malformed routing %o', patch => {
        const value = event()
        expect(() => assertStripeEventEnvelope({ ...value, data: { object: { ...value.data.object, ...patch } } })).toThrow('EVENT_CONTEXT_DENIED')
    })
    it('requires charge refund and dispute risk fields', () => {
        const base = event()
        expect(() => assertStripeEventEnvelope({ ...base, type: 'charge.refunded', data: { object: { id: 'ch_test', object: 'charge', refunded: true } } })).not.toThrow()
        expect(() => assertStripeEventEnvelope({ ...base, type: 'charge.refunded', data: { object: { id: 'ch_test', object: 'charge' } } })).toThrow('EVENT_CONTEXT_DENIED')
        expect(() => assertStripeEventEnvelope({ ...base, type: 'charge.dispute.created', data: { object: { id: 'dp_test', object: 'dispute', charge: 'ch_test', status: 'unknown' } } })).toThrow('EVENT_CONTEXT_DENIED')
    })
})
