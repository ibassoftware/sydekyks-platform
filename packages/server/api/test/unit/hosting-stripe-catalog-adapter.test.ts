import { hostingCatalog } from '@activepieces/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeDigest } from '../../src/app/hosting/hosting-stripe-policy'
import { StripeCommand } from '../../src/app/hosting/hosting-stripe-entities'
import { createStripeAdapter } from '../../src/app/hosting/hosting-stripe-adapter'

const transport = vi.hoisted(() => ({ accounts: { retrieve: vi.fn() }, prices: { retrieve: vi.fn() }, billingPortal: { configurations: { retrieve: vi.fn() } }, customers: { retrieve: vi.fn(), create: vi.fn() }, subscriptions: { list: vi.fn(), retrieve: vi.fn(), update: vi.fn() }, checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } } }))
vi.mock('stripe', () => ({ default: class { constructor() { return transport } } }))
const catalog = { version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_growth', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } }
const adapter = () => createStripeAdapter({ secret: 'sk_test_synthetic', signingSecret: 'whsec_synthetic', hash: 'synthetic', catalog })
const price = (id: string) => ({ id, livemode: false, active: true, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, unit_amount: Object.values(catalog.plans).find(value => value.priceId === id)!.amountMinor, currency: 'usd', billing_scheme: 'per_unit', transform_quantity: null })
beforeEach(() => {
    vi.clearAllMocks()
    transport.accounts.retrieve.mockResolvedValue({ id: 'acct_synthetic' })
    transport.prices.retrieve.mockImplementation(async id => price(id))
    transport.billingPortal.configurations.retrieve.mockResolvedValue({ id: 'bpc_synthetic', livemode: false, active: true, features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' } } })
    transport.customers.retrieve.mockResolvedValue({ id: 'cus_synthetic', livemode: false, metadata: { hostingPlatformId: 'platform-synthetic' } })
    transport.subscriptions.list.mockResolvedValue({ has_more: false, data: [] })
})
describe('read-only Stripe catalog verification', () => {
    it('validates all three catalog prices and protected portal settings without any purchase or subscription mutation', async () => {
        const value = await (await adapter()).catalogEvidence({ customerId: null, subscriptionId: null, chargeIds: [] })
        expect(value.issues).toEqual([])
        expect(transport.prices.retrieve.mock.calls.map(args => args[0])).toEqual(['price_starter', 'price_growth', 'price_scale'])
        expect(transport.customers.create).not.toHaveBeenCalled(); expect(transport.subscriptions.update).not.toHaveBeenCalled(); expect(transport.checkout.sessions.create).not.toHaveBeenCalled()
    })
    it('rejects a merchant mismatch, live object, inactive or differently priced catalog before migration', async () => {
        transport.accounts.retrieve.mockResolvedValue({ id: 'acct_other' })
        await expect((await adapter()).catalogEvidence({ customerId: null, subscriptionId: null, chargeIds: [] })).rejects.toThrow('ACCOUNT_MISMATCH')
        transport.accounts.retrieve.mockResolvedValue({ id: 'acct_synthetic' })
        for (const delta of [{ livemode: true }, { active: false }, { unit_amount: 9901 }, { currency: 'eur' }, { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } }]) {
            transport.prices.retrieve.mockImplementation(async id => ({ ...price(id), ...delta }))
            await expect((await adapter()).catalogEvidence({ customerId: null, subscriptionId: null, chargeIds: [] })).rejects.toThrow(/LIVE_OBJECT_DENIED|PRICE_DENIED/)
        }
    })
    it('proves expired checkout remotely and retires only ready portal delivery, without claiming remote revocation', async () => {
        const payload = { customerId: 'cus_synthetic' }
        const command = { id: 'synthetic', platformId: 'synthetic', kind: 'checkout', state: 'ready', firstSentAt: new Date(), objectId: 'cs_synthetic', payload, payloadHash: stripeDigest(payload) } as StripeCommand
        transport.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_synthetic', livemode: false, customer: 'cus_synthetic', mode: 'subscription', status: 'expired', subscription: null })
        const value = await (await adapter()).catalogCommandEvidence([command, { ...command, id: 'portal', kind: 'portal', objectId: 'bps_synthetic' }], 'cus_synthetic', null)
        expect(value.map(row => row.reason)).toEqual(['checkout_expired', 'portal_delivery_retired'])
        transport.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_synthetic', livemode: false, customer: 'cus_synthetic', mode: 'subscription', status: 'open', subscription: null })
        await expect((await adapter()).catalogCommandEvidence([command], 'cus_synthetic', null)).rejects.toThrow('OPEN_COMMANDS')
        await expect((await adapter()).catalogCommandEvidence([{ ...command, kind: 'portal', state: 'uncertain' }], 'cus_synthetic', null)).rejects.toThrow('OPEN_COMMANDS')
        expect(transport.subscriptions.update).not.toHaveBeenCalled(); expect(transport.checkout.sessions.create).not.toHaveBeenCalled()
    })
    it('refuses an existing subscription with a same-dollar different price ID', async () => {
        transport.subscriptions.list.mockResolvedValue({ has_more: false, data: [{ id: 'sub_synthetic', livemode: false, status: 'active', customer: 'cus_synthetic', items: { has_more: false, data: [{ id: 'si_synthetic', price: { ...price('price_starter'), id: 'price_legacy' }, quantity: 1 }] }, pause_collection: null, pending_update: null, schedule: null, trial_start: null, trial_end: null, discounts: [], collection_method: 'charge_automatically' }] })
        const value = await (await adapter()).catalogEvidence({ customerId: 'cus_synthetic', subscriptionId: 'sub_synthetic', chargeIds: [] })
        expect(value.issues).toEqual(['HOSTING_STRIPE_PRICE_DENIED'])
        expect(transport.subscriptions.update).not.toHaveBeenCalled()
    })
})
