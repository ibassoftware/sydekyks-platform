import { hostingCatalog } from '@activepieces/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStripeAdapter } from '../../src/app/hosting/hosting-stripe-adapter'
import { StripeCommand } from '../../src/app/hosting/hosting-stripe-entities'

const transport = vi.hoisted(() => ({ accounts: { retrieve: vi.fn() }, prices: { retrieve: vi.fn() }, customers: { retrieve: vi.fn() }, subscriptions: { retrieve: vi.fn(), update: vi.fn(), list: vi.fn() }, invoices: { retrieve: vi.fn(), listLineItems: vi.fn() }, invoicePayments: { list: vi.fn() }, paymentIntents: { retrieve: vi.fn() }, charges: { retrieve: vi.fn() }, refunds: { list: vi.fn() }, disputes: { list: vi.fn() } }))
vi.mock('stripe', () => ({ default: function StripeMock() {
    return transport
} }))
const catalog = { version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_growth', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } }
const adapter = () => createStripeAdapter({ secret: 'sk_test_synthetic', signingSecret: 'whsec_synthetic', hash: 'synthetic', catalog })
const start = 1792627200, end = start + 30 * 86400
const command = (): StripeCommand => ({ id: 'change-synthetic', created: new Date(), updated: new Date(), platformId: 'platform-synthetic', kind: 'plan_change', state: 'running', actorIdentityId: 'i'.repeat(21), tokenVersion: 'initial', payloadHash: 'synthetic', fence: 'synthetic', leaseUntil: new Date(), objectId: null, url: null, expiresAt: null, firstSentAt: new Date(), idempotencyKey: 'synthetic-stable-key', payload: { customerId: 'cus_synthetic', subscriptionId: 'sub_synthetic', planId: 'team', effectiveAt: new Date(end * 1000).toISOString() } })
const price = (id: string) => ({ id, livemode: false, active: true, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, unit_amount: Object.values(catalog.plans).find(value => value.priceId === id)!.amountMinor, currency: 'usd', billing_scheme: 'per_unit', transform_quantity: null })
function subscription() {
    return { id: 'sub_synthetic', livemode: false, customer: 'cus_synthetic', status: 'active', metadata: { hostingPlatformId: 'platform-synthetic', hostingCommandId: 'checkout-synthetic' }, items: { has_more: false, data: [{ id: 'si_synthetic', price: price('price_starter'), quantity: 1, current_period_start: start, current_period_end: end }] }, pause_collection: null, pending_update: null, schedule: null, trial_start: null, trial_end: null, discounts: [], cancel_at_period_end: false, cancel_at: null, collection_method: 'charge_automatically', latest_invoice: 'in_synthetic' }
}
beforeEach(() => {
    vi.resetAllMocks()
    transport.accounts.retrieve.mockResolvedValue({ id: catalog.accountId })
    transport.prices.retrieve.mockImplementation(async id => price(id))
    transport.subscriptions.retrieve.mockResolvedValue(subscription())
    transport.subscriptions.update.mockImplementation(async (_id, body) => ({ ...subscription(), metadata: { ...subscription().metadata, ...body.metadata }, items: { has_more: false, data: [{ ...subscription().items.data[0], price: price(body.items[0].price) }] } }))
})
describe('Stripe price changes without free credit or cycle reset', () => {
    it('updates the exact subscription item with no proration and unchanged billing anchor', async () => {
        const value = await (await adapter()).create(command())
        expect(value).toEqual({ objectId: 'sub_synthetic', url: null, expiresAt: new Date(end * 1000) })
        expect(transport.subscriptions.update).toHaveBeenCalledExactlyOnceWith('sub_synthetic', { items: [{ id: 'si_synthetic', price: 'price_growth', quantity: 1 }], proration_behavior: 'none', billing_cycle_anchor: 'unchanged', metadata: { hostingNextPlan: 'team', hostingPlanChangeCommandId: 'change-synthetic' } }, { idempotencyKey: 'synthetic-stable-key' })
    })
    it.each([
        ['different customer', { customer: 'cus_other' }], ['wrong tenant', { metadata: { hostingPlatformId: 'other-platform' } }], ['paused subscription', { pause_collection: {} }], ['pending change', { pending_update: {} }], ['scheduled subscription', { schedule: 'sub_sched_other' }], ['cancelling subscription', { cancel_at_period_end: true }], ['discounted subscription', { discounts: ['di_other'] }], ['live subscription', { livemode: true }],
    ])('refuses %s before a provider mutation', async (_label, delta) => {
        transport.subscriptions.retrieve.mockResolvedValue({ ...subscription(), ...delta })
        await expect((await adapter()).create(command())).rejects.toThrow(/PLAN_CHANGE_UNSUPPORTED|LIVE_OBJECT_DENIED/)
        expect(transport.subscriptions.update).not.toHaveBeenCalled()
    })
    it.each([
        ['quantity two', { quantity: 2 }], ['stale paid cycle', { current_period_end: end + 1 }], ['unknown price', { price: { ...price('price_starter'), id: 'price_other' } }],
    ])('refuses %s on the current item before mutation', async (_label, delta) => {
        const sub = subscription(); sub.items.data[0] = { ...sub.items.data[0], ...delta }
        transport.subscriptions.retrieve.mockResolvedValue(sub)
        await expect((await adapter()).create(command())).rejects.toThrow('PLAN_CHANGE_STALE')
        expect(transport.subscriptions.update).not.toHaveBeenCalled()
    })
    it('refuses multiple subscription items or a live replacement price before mutation', async () => {
        const sub = subscription(); sub.items.data.push({ ...sub.items.data[0], id: 'si_extra' })
        transport.subscriptions.retrieve.mockResolvedValue(sub)
        await expect((await adapter()).create(command())).rejects.toThrow('PLAN_CHANGE_UNSUPPORTED')
        transport.subscriptions.retrieve.mockResolvedValue(subscription()); transport.prices.retrieve.mockResolvedValue({ ...price('price_growth'), livemode: true })
        await expect((await adapter()).create(command())).rejects.toThrow('LIVE_OBJECT_DENIED')
        expect(transport.subscriptions.update).not.toHaveBeenCalled()
    })
    it.each(['customer', 'item', 'cycle', 'price', 'quantity', 'command', 'live'])('refuses an unverified %s update receipt', async mismatch => {
        transport.subscriptions.update.mockImplementation(async () => {
            const sub = { ...subscription(), metadata: { ...subscription().metadata, hostingPlanChangeCommandId: 'change-synthetic' }, items: { has_more: false, data: [{ ...subscription().items.data[0], price: price('price_growth') }] } }
            if (mismatch === 'customer') sub.customer = 'cus_other'
            if (mismatch === 'item') sub.items.data[0].id = 'si_other'
            if (mismatch === 'cycle') sub.items.data[0].current_period_end++
            if (mismatch === 'price') sub.items.data[0].price = price('price_starter')
            if (mismatch === 'quantity') sub.items.data[0].quantity = 2
            if (mismatch === 'command') sub.metadata.hostingPlanChangeCommandId = 'other-command'
            if (mismatch === 'live') sub.livemode = true
            return sub
        })
        await expect((await adapter()).create(command())).rejects.toThrow(/PLAN_CHANGE_STALE|LIVE_OBJECT_DENIED/)
    })
    it('reads the already-paid old invoice as the current plan when the future subscription price has changed', async () => {
        const sub = { ...subscription(), metadata: { ...subscription().metadata, hostingNextPlan: 'team', hostingPlanChangeCommandId: 'change-synthetic' }, items: { has_more: false, data: [{ ...subscription().items.data[0], price: price('price_growth') }] } }
        transport.customers.retrieve.mockResolvedValue({ id: 'cus_synthetic', livemode: false, metadata: { hostingPlatformId: 'platform-synthetic' } })
        transport.subscriptions.list.mockResolvedValue({ data: [sub], has_more: false })
        transport.invoices.retrieve.mockResolvedValue({ id: 'in_synthetic', livemode: false, customer: 'cus_synthetic', parent: { subscription_details: { subscription: sub.id } }, status: 'paid', billing_reason: 'subscription_cycle', amount_remaining: 0, amount_paid: 9900, total: 9900, amount_due: 9900, starting_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, currency: 'usd', discounts: [] })
        transport.invoices.listLineItems.mockResolvedValue({ has_more: false, data: [{ id: 'il_synthetic', livemode: false, invoice: 'in_synthetic', quantity: 1, amount: 9900, currency: 'usd', discount_amounts: [], pretax_credit_amounts: [], parent: { subscription_item_details: { proration: false, subscription_item: 'si_synthetic', subscription: sub.id } }, pricing: { price_details: { price: 'price_starter' } }, period: { start, end } }] })
        transport.invoicePayments.list.mockResolvedValue({ has_more: false, data: [{ id: 'ip_synthetic', livemode: false, invoice: 'in_synthetic', amount_paid: 9900, amount_requested: 9900, currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_synthetic' } }] })
        transport.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_synthetic', livemode: false, status: 'succeeded', amount_received: 9900, amount: 9900, currency: 'usd', customer: 'cus_synthetic', latest_charge: 'ch_synthetic' })
        transport.charges.retrieve.mockResolvedValue({ id: 'ch_synthetic', livemode: false, payment_intent: 'pi_synthetic', customer: 'cus_synthetic', payment_method_details: { type: 'card' }, status: 'succeeded', paid: true, captured: true, amount: 9900, amount_captured: 9900, currency: 'usd', amount_refunded: 0, refunded: false })
        transport.refunds.list.mockResolvedValue({ has_more: false, data: [] }); transport.disputes.list.mockResolvedValue({ has_more: false, data: [] })
        const result = await (await adapter()).snapshot({ customerId: 'cus_synthetic', previousSubscriptionId: 'sub_synthetic', chargeIds: [] })
        expect(result.issues).toEqual([])
        expect(result.period).toMatchObject({ planId: 'starter', priceId: 'price_starter', start, end })
        expect(result.pendingPlan).toEqual({ planId: 'team', effectiveAt: end, commandId: 'change-synthetic' })
        expect(transport.subscriptions.update).not.toHaveBeenCalled()
    })
})
