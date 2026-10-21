import { hostingCatalog } from '@activepieces/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPartnerStripeAdapter, partnerMetadata, PartnerStripePolicy } from '../../src/app/hosting/hosting-partner-billing-adapter'
import { PartnerPurchase } from '../../src/app/hosting/hosting-partner-billing-entities'

const transport = vi.hoisted(() => ({ accounts: { retrieve: vi.fn() }, prices: { retrieve: vi.fn() }, customers: { retrieve: vi.fn(), create: vi.fn() }, checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), listLineItems: vi.fn() } }, paymentIntents: { retrieve: vi.fn() }, charges: { retrieve: vi.fn() }, refunds: { list: vi.fn() } }))
vi.mock('stripe', () => ({ default: function SyntheticStripe() {
    return transport 
} }))
const policy = { secret: 'sk_test_synthetic', signingSecret: 'whsec_synthetic', hash: 'hash', catalog: { accountId: 'acct_synthetic', version: hostingCatalog.version, origin: 'http://localhost', portalConfigurationId: 'bpc_synthetic', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_growth', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } }, partnerCourseId: 'syntheticcourse1234567', partnerPackages: { core: { priceId: 'price_core', amountMinor: 100000, currency: 'usd' }, guided: { priceId: 'price_guided', amountMinor: 120000, currency: 'usd' } } } as PartnerStripePolicy
const purchase = (selected: 'core' | 'guided' = 'core') => ({ id: 'syntheticpurchase12345', identityId: 'syntheticidentity12345', platformId: 'syntheticplatform12345', courseId: policy.partnerCourseId, package: selected, stripeAccountId: policy.catalog.accountId, policyHash: policy.hash, ...policy.partnerPackages[selected], firstSentAt: new Date(), customerId: 'cus_synthetic', sessionId: 'cs_synthetic' } as unknown as PartnerPurchase)
function fixture(row = purchase()) {
    const metadata = partnerMetadata(row), amount = row.amountMinor
    transport.accounts.retrieve.mockResolvedValue({ id: policy.catalog.accountId })
    transport.prices.retrieve.mockResolvedValue({ id: row.priceId, livemode: false, active: true, type: 'one_time', recurring: null, unit_amount: amount, currency: 'usd', billing_scheme: 'per_unit' })
    transport.customers.retrieve.mockResolvedValue({ id: row.customerId, livemode: false, metadata })
    transport.customers.create.mockResolvedValue({ id: row.customerId, livemode: false, metadata })
    transport.checkout.sessions.create.mockResolvedValue({ id: row.sessionId, livemode: false, customer: row.customerId, mode: 'payment', metadata, client_reference_id: row.platformId, url: 'https://checkout.stripe.com/c/pay/synthetic', expires_at: Math.floor(Date.now() / 1000) + 3600 })
    transport.checkout.sessions.retrieve.mockResolvedValue({ id: row.sessionId, livemode: false, customer: row.customerId, mode: 'payment', metadata, client_reference_id: row.platformId, currency: 'usd', amount_subtotal: amount, amount_total: amount, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 }, status: 'complete', payment_status: 'paid', payment_intent: 'pi_synthetic' })
    transport.checkout.sessions.listLineItems.mockResolvedValue({ has_more: false, data: [{ quantity: 1, price: { id: row.priceId }, currency: 'usd', amount_subtotal: amount, amount_total: amount, amount_discount: 0, amount_tax: 0 }] })
    transport.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_synthetic', livemode: false, customer: row.customerId, currency: 'usd', amount, amount_received: amount, capture_method: 'automatic', payment_method_types: ['card'], status: 'succeeded', latest_charge: 'ch_synthetic', metadata })
    transport.charges.retrieve.mockResolvedValue({ id: 'ch_synthetic', livemode: false, customer: row.customerId, payment_intent: 'pi_synthetic', currency: 'usd', amount, amount_captured: amount, amount_refunded: 0, refunded: false, paid: true, captured: true, status: 'succeeded', payment_method_details: { type: 'card' } })
    transport.refunds.list.mockResolvedValue({ has_more: false, data: [] })
}
beforeEach(() => {
    vi.clearAllMocks(); fixture() 
})
describe('Partner test-mode payment evidence', () => {
    it.each(['core', 'guided'] as const)('verifies %s paid card evidence and uses durable one-time checkout metadata and idempotency keys', async selected => {
        const row = purchase(selected); fixture(row)
        const adapter = await createPartnerStripeAdapter(policy)
        await adapter.customer(row); await adapter.create(row)
        expect(transport.customers.create.mock.calls[0][1].idempotencyKey).toContain(`customer:${row.id}`)
        expect(transport.checkout.sessions.create.mock.calls[0]).toMatchObject([{ mode: 'payment', customer: row.customerId, metadata: partnerMetadata(row), payment_intent_data: { metadata: partnerMetadata(row) }, payment_method_types: ['card'], line_items: [{ price: row.priceId, quantity: 1 }] }, { idempotencyKey: expect.stringContaining(`checkout:${row.id}`) }])
        expect(await adapter.snapshot(row)).toMatchObject({ status: 'paid', amountMinor: row.amountMinor, refundedMinor: 0, chargeId: 'ch_synthetic' })
    })
    it('denies merchant mismatch and recurring, discounted, live or differently priced products before creating a session', async () => {
        const adapter = await createPartnerStripeAdapter(policy)
        transport.accounts.retrieve.mockResolvedValue({ id: 'acct_other' })
        await expect(adapter.create(purchase())).rejects.toThrow('ACCOUNT_MISMATCH')
        for (const delta of [{ type: 'recurring' }, { livemode: true }, { unit_amount: 99999 }, { currency: 'eur' }, { active: false }]) {
            fixture(); transport.prices.retrieve.mockResolvedValue({ ...(await transport.prices.retrieve()), ...delta })
            await expect(adapter.create(purchase())).rejects.toThrow(/PRICE_DENIED|LIVE_OBJECT_DENIED/)
        }
        expect(transport.checkout.sessions.create).not.toHaveBeenCalled()
    })
    it('refuses another customer, identity, workspace, course or command metadata and underpaid/uncaptured/non-card charges', async () => {
        const adapter = await createPartnerStripeAdapter(policy)
        for (const key of Object.keys(partnerMetadata(purchase()))) {
            fixture(); const session = await transport.checkout.sessions.retrieve(); session.metadata = { ...session.metadata, [key]: 'other' }
            transport.checkout.sessions.retrieve.mockResolvedValue(session)
            await expect(adapter.snapshot(purchase())).rejects.toThrow('METADATA_MISMATCH')
        }
        for (const delta of [{ customer: 'cus_other' }, { captured: false }, { paid: false }, { amount_captured: 99999 }, { amount: 99999 }, { payment_method_details: { type: 'bank_transfer' } }]) {
            fixture(); transport.charges.retrieve.mockResolvedValue({ ...(await transport.charges.retrieve()), ...delta })
            await expect(adapter.snapshot(purchase())).rejects.toThrow('PAYMENT_UNVERIFIED')
        }
    })
    it('reconciles successful partial and full refunds against the original charge, refusing incomplete evidence', async () => {
        const adapter = await createPartnerStripeAdapter(policy)
        for (const refundedMinor of [100, 100000]) {
            fixture(); transport.charges.retrieve.mockResolvedValue({ ...(await transport.charges.retrieve()), amount_refunded: refundedMinor, refunded: refundedMinor === 100000 })
            transport.refunds.list.mockResolvedValue({ has_more: false, data: [{ id: 're_synthetic', charge: 'ch_synthetic', payment_intent: 'pi_synthetic', amount: refundedMinor, currency: 'usd', status: 'succeeded' }] })
            expect(await adapter.snapshot(purchase())).toMatchObject({ status: 'paid', refundedMinor })
            transport.refunds.list.mockResolvedValue({ has_more: true, data: [] })
            await expect(adapter.snapshot(purchase())).rejects.toThrow('REFUND_UNVERIFIED')
        }
    })
    it('accepts automatic async capture only after the original paid card charge is fully captured, and rejects manual capture', async () => {
        const adapter = await createPartnerStripeAdapter(policy)
        transport.paymentIntents.retrieve.mockResolvedValue({ ...(await transport.paymentIntents.retrieve()), capture_method: 'automatic_async' })
        const charged = await transport.charges.retrieve()
        transport.charges.retrieve.mockResolvedValue({ ...charged, captured: false, amount_captured: 0 })
        await expect(adapter.snapshot(purchase())).rejects.toThrow('PAYMENT_UNVERIFIED')
        transport.charges.retrieve.mockResolvedValue({ ...charged, captured: true, amount_captured: 99999 })
        await expect(adapter.snapshot(purchase())).rejects.toThrow('PAYMENT_UNVERIFIED')
        transport.charges.retrieve.mockResolvedValue(charged)
        expect(await adapter.snapshot(purchase())).toMatchObject({ status: 'paid', amountMinor: 100000 })
        transport.paymentIntents.retrieve.mockResolvedValue({ ...(await transport.paymentIntents.retrieve()), capture_method: 'manual' })
        await expect(adapter.snapshot(purchase())).rejects.toThrow('PAYMENT_UNVERIFIED')
    })
    it('monitors immutable historical receipts after the configured price changes or the original price becomes inactive', async () => {
        const row = purchase(), changed = { ...policy, hash: 'new-policy', partnerCourseId: 'different-course', partnerPackages: { ...policy.partnerPackages, core: { ...policy.partnerPackages.core, priceId: 'price_newcore' } } }
        transport.prices.retrieve.mockResolvedValue({ ...(await transport.prices.retrieve()), active: false })
        const adapter = await createPartnerStripeAdapter(changed)
        expect(await adapter.snapshot(row)).toMatchObject({ status: 'paid' })
        await expect(adapter.create(row)).rejects.toThrow('POLICY_CHANGED')
    })
    it('does not treat an open or expired redirect/session as payment authority', async () => {
        const adapter = await createPartnerStripeAdapter(policy)
        for (const status of ['open', 'expired']) {
            fixture(); transport.checkout.sessions.retrieve.mockResolvedValue({ ...(await transport.checkout.sessions.retrieve()), status, payment_status: 'unpaid', payment_intent: null })
            expect(await adapter.snapshot(purchase())).toEqual({ status })
        }
        expect(transport.paymentIntents.retrieve).not.toHaveBeenCalled()
    })
})
