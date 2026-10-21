import { hostingCatalog } from '@activepieces/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStripeAdapter } from '../../src/app/hosting/hosting-stripe-adapter'
import { STRIPE_API_VERSION } from '../../src/app/hosting/hosting-stripe-policy'

const transport = vi.hoisted(() => ({
    initialize: vi.fn(),
    webhooks: { constructEvent: vi.fn() },
    accounts: { retrieve: vi.fn() },
    events: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
    customers: { create: vi.fn() },
    subscriptions: { update: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    invoicePayments: { list: vi.fn() },
}))
vi.mock('stripe', () => ({
    default: function SyntheticStripe(secret: string, options: unknown): typeof transport {
        transport.initialize(secret, options)
        return transport
    },
}))
const catalog = {
    version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost',
    plans: {
        starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' },
        team: { priceId: 'price_team', amountMinor: 39900, currency: 'usd' },
        scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' },
    },
}
const policy = { secret: 'sk_test_synthetic', signingSecret: 'whsec_synthetic', hash: 'synthetic', catalog }
function legacyRefund() {
    return { id: 'evt_legacyRefund', type: 'refund.updated', created: 1770000000, livemode: false, api_version: '2020-08-27', data: { object: { id: 're_legacyRefund', object: 'refund', charge: 'ch_synthetic', status: 'succeeded', amount: 9900 } } }
}
beforeEach(() => {
    vi.clearAllMocks()
    transport.accounts.retrieve.mockResolvedValue({ id: catalog.accountId })
    transport.events.retrieve.mockResolvedValue(legacyRefund())
    transport.webhooks.constructEvent.mockReturnValue(legacyRefund())
    transport.charges.retrieve.mockResolvedValue({ id: 'ch_synthetic', livemode: false, customer: 'cus_synthetic' })
})
describe('signed webhook and pinned-merchant fallback routing', () => {
    it('verifies the signature before accepting the explicit legacy envelope, without treating its payload as payment evidence', async () => {
        const adapter = await createStripeAdapter(policy)
        const event = legacyRefund(), raw = JSON.stringify(event)
        expect(adapter.verify(raw, 'synthetic-signature')).toEqual(event)
        expect(transport.webhooks.constructEvent).toHaveBeenCalledWith(raw, 'synthetic-signature', policy.signingSecret, 300)
        expect(transport.accounts.retrieve).not.toHaveBeenCalled()
        expect(transport.events.retrieve).not.toHaveBeenCalled()
        expect(transport.charges.retrieve).not.toHaveBeenCalled()
        expect(transport.invoicePayments.list).not.toHaveBeenCalled()
        expect(transport.customers.create).not.toHaveBeenCalled()
        expect(transport.subscriptions.update).not.toHaveBeenCalled()
        expect(transport.checkout.sessions.create).not.toHaveBeenCalled()
    })
    it('routes a legacy refund lacking a customer through the exact merchant and a test-mode charge read using the pinned API', async () => {
        const adapter = await createStripeAdapter(policy)
        expect(await adapter.eventCustomer('evt_legacyRefund')).toBe('cus_synthetic')
        expect(transport.initialize).toHaveBeenCalledWith(policy.secret, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 15000 })
        expect(transport.accounts.retrieve).toHaveBeenCalledTimes(1)
        expect(transport.events.retrieve).toHaveBeenCalledWith('evt_legacyRefund')
        expect(transport.charges.retrieve).toHaveBeenCalledWith('ch_synthetic')
        expect(transport.accounts.retrieve.mock.invocationCallOrder[0]).toBeLessThan(transport.events.retrieve.mock.invocationCallOrder[0])
        expect(transport.events.retrieve.mock.invocationCallOrder[0]).toBeLessThan(transport.charges.retrieve.mock.invocationCallOrder[0])
        expect(transport.invoicePayments.list).not.toHaveBeenCalled()
        expect(transport.customers.create).not.toHaveBeenCalled()
        expect(transport.subscriptions.update).not.toHaveBeenCalled()
        expect(transport.checkout.sessions.create).not.toHaveBeenCalled()
    })
    it('also routes valid pinned-version customer references without a charge read', async () => {
        transport.events.retrieve.mockResolvedValue({ ...legacyRefund(), api_version: STRIPE_API_VERSION, data: { object: { ...legacyRefund().data.object, customer: { id: 'cus_expanded' } } } })
        expect(await (await createStripeAdapter(policy)).eventCustomer('evt_legacyRefund')).toBe('cus_expanded')
        expect(transport.charges.retrieve).not.toHaveBeenCalled()
    })
    it('rejects an invalid signature without attempting remote reads or payment operations', async () => {
        transport.webhooks.constructEvent.mockImplementation(() => {
            throw new Error('Synthetic invalid signature') 
        })
        const adapter = await createStripeAdapter(policy)
        expect(() => adapter.verify('{}', 'invalid')).toThrow('HOSTING_STRIPE_SIGNATURE_INVALID')
        expect(transport.events.retrieve).not.toHaveBeenCalled()
        expect(transport.accounts.retrieve).not.toHaveBeenCalled()
        expect(transport.charges.retrieve).not.toHaveBeenCalled()
    })
    it('rejects a different merchant before retrieving the fallback event or charge', async () => {
        transport.accounts.retrieve.mockResolvedValue({ id: 'acct_other' })
        await expect((await createStripeAdapter(policy)).eventCustomer('evt_legacyRefund')).rejects.toThrow('HOSTING_STRIPE_ACCOUNT_MISMATCH')
        expect(transport.events.retrieve).not.toHaveBeenCalled()
        expect(transport.charges.retrieve).not.toHaveBeenCalled()
    })
    it.each([
        { livemode: true },
        { account: 'acct_connected' },
        { context: 'acct_other' },
        { api_version: '2026-09-30.clover' },
        { api_version: null },
        { id: 'in_wrongKind' },
        { data: { object: { id: 're_wrong', object: 'charge', charge: 'ch_synthetic' } } },
        { data: { object: { id: 're_wrong', object: 'refund', charge: 'cus_wrongKind' } } },
        { data: { object: { id: 're_wrong', object: 'refund', customer: 'cus_wrong/slash' } } },
    ])('rejects unsupported or malformed context on both signed and fallback paths: %o', async patch => {
        const event = { ...legacyRefund(), ...patch }
        transport.webhooks.constructEvent.mockReturnValue(event)
        transport.events.retrieve.mockResolvedValue(event)
        const adapter = await createStripeAdapter(policy)
        expect(() => adapter.verify(JSON.stringify(event), 'synthetic-signature')).toThrow('HOSTING_STRIPE_EVENT_CONTEXT_DENIED')
        await expect(adapter.eventCustomer('evt_legacyRefund')).rejects.toThrow('HOSTING_STRIPE_EVENT_CONTEXT_DENIED')
        expect(transport.charges.retrieve).not.toHaveBeenCalled()
    })
    it('rejects a live charge even when its signed legacy routing envelope is test-mode', async () => {
        transport.charges.retrieve.mockResolvedValue({ id: 'ch_synthetic', livemode: true, customer: 'cus_synthetic' })
        await expect((await createStripeAdapter(policy)).eventCustomer('evt_legacyRefund')).rejects.toThrow('HOSTING_STRIPE_LIVE_OBJECT_DENIED')
    })
    it('returns no customer when a supported envelope has no routing references, without inventing payment authority', async () => {
        transport.events.retrieve.mockResolvedValue({ ...legacyRefund(), type: 'invoice.paid', data: { object: { id: 'in_synthetic', object: 'invoice', paid: true, amount_paid: 9900 } } })
        expect(await (await createStripeAdapter(policy)).eventCustomer('evt_legacyRefund')).toBeNull()
        expect(transport.charges.retrieve).not.toHaveBeenCalled()
        expect(transport.invoicePayments.list).not.toHaveBeenCalled()
        expect(transport.checkout.sessions.create).not.toHaveBeenCalled()
    })
})
