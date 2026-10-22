import type Stripe from 'stripe'
import { z } from 'zod'
import { StripeCommand } from './hosting-stripe-entities'
import { assertStripeEventEnvelope } from './hosting-stripe-event'
import { HostedStripeCatalog, STRIPE_API_VERSION, stripeDigest, stripeId } from './hosting-stripe-policy'
import { HostingError, hostingFail } from './hosting-transactions'

type Policy = { secret: string, signingSecret: string, catalog: HostedStripeCatalog, hash: string }
export type PaidPeriodEvidence = { subscriptionId: string, itemId: string, priceId: string, planId: 'starter' | 'team' | 'scale', start: number, end: number, invoiceId: string, lineId: string, chargeId: string }
export type ChargeEvidence = { id: string, refunded: boolean, lost: boolean, holds: string[] }
export async function createStripeAdapter(policy: Policy) {
    const { default: StripeSdk } = await import('stripe')
    const client = new StripeSdk(policy.secret, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 15000 })
    async function account(): Promise<void> {
        if ((await client.accounts.retrieve()).id !== policy.catalog.accountId) hostingFail('HOSTING_STRIPE_ACCOUNT_MISMATCH')
    }
    function verify(raw: string, signature: string): Stripe.Event {
        let event: Stripe.Event
        try {
            event = client.webhooks.constructEvent(raw, signature, policy.signingSecret, 300)
        }
        catch {
            hostingFail('HOSTING_STRIPE_SIGNATURE_INVALID')
        }
        assertStripeEventEnvelope(event)
        return event
    }
    async function create(command: StripeCommand): Promise<{ objectId: string, url: string | null, expiresAt: Date | null }> {
        await account()
        const options = { idempotencyKey: command.idempotencyKey }
        if (command.kind === 'customer') {
            const result = await client.customers.create({ metadata: { hostingPlatformId: command.platformId, hostingCommandId: command.id } }, options)
            test(result)
            return { objectId: result.id, url: null, expiresAt: null }
        }
        const customer = z.string().regex(/^cus_[a-zA-Z0-9]+$/).parse(command.payload.customerId)
        if (command.kind === 'plan_change') {
            const plan = z.enum(['starter', 'team', 'scale']).parse(command.payload.planId)
            const subscriptionId = z.string().regex(/^sub_[a-zA-Z0-9]+$/).parse(command.payload.subscriptionId)
            const effectiveAt = z.iso.datetime().parse(command.payload.effectiveAt)
            const expected = policy.catalog.plans[plan]
            await price(expected)
            const sub = await client.subscriptions.retrieve(subscriptionId)
            test(sub)
            if (stripeId(sub.customer) !== customer || sub.metadata.hostingPlatformId !== command.platformId || sub.items.has_more || sub.items.data.length !== 1 || sub.status !== 'active' || sub.pause_collection || sub.pending_update || sub.schedule || sub.trial_start || sub.trial_end || sub.discounts.length || sub.cancel_at_period_end || sub.cancel_at || sub.collection_method !== 'charge_automatically') hostingFail('HOSTING_STRIPE_PLAN_CHANGE_UNSUPPORTED')
            const item = sub.items.data[0]
            if (item.quantity !== 1 || item.current_period_end * 1000 !== Date.parse(effectiveAt) || !Object.values(policy.catalog.plans).some(value => value.priceId === item.price.id)) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_STALE')
            // A price update without proration leaves the existing paid invoice,
            // cycle and local entitlement intact. Only the next verified paid
            // renewal supplies the new plan and its allowance.
            const result = await client.subscriptions.update(sub.id, {
                items: [{ id: item.id, price: expected.priceId, quantity: 1 }],
                proration_behavior: 'none', billing_cycle_anchor: 'unchanged',
                metadata: { hostingNextPlan: plan, hostingPlanChangeCommandId: command.id },
            }, options)
            test(result)
            const updated = result.items.data[0]
            if (result.id !== sub.id || stripeId(result.customer) !== customer || result.items.data.length !== 1 || result.items.has_more || !updated || updated.id !== item.id || updated.price.id !== expected.priceId || updated.quantity !== 1 || updated.current_period_end !== item.current_period_end || updated.current_period_start !== item.current_period_start || result.metadata.hostingPlanChangeCommandId !== command.id) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_STALE')
            return { objectId: result.id, url: null, expiresAt: new Date(effectiveAt) }
        }
        if (command.kind === 'checkout') {
            const plan = z.enum(['starter', 'team', 'scale']).parse(command.payload.planId)
            const expected = policy.catalog.plans[plan]
            await price(expected)
            const result = await client.checkout.sessions.create({ customer, mode: 'subscription', payment_method_types: ['card'], line_items: [{ price: expected.priceId, quantity: 1 }], allow_promotion_codes: false, automatic_tax: { enabled: false }, success_url: `${policy.catalog.origin}/settings/billing?checkout=success`, cancel_url: `${policy.catalog.origin}/settings/billing?checkout=cancel`, expires_at: Math.floor(requiredTime(command.firstSentAt).getTime() / 1000) + 3600, client_reference_id: command.platformId, metadata: { hostingCommandId: command.id, hostingPlatformId: command.platformId }, subscription_data: { metadata: { hostingCommandId: command.id, hostingPlatformId: command.platformId } } }, options)
            test(result)
            if (stripeId(result.customer) !== customer || !result.url) hostingFail('HOSTING_STRIPE_OBJECT_MISMATCH')
            return { objectId: result.id, url: providerUrl(result.url, 'checkout.stripe.com'), expiresAt: new Date(result.expires_at * 1000) }
        }
        const config = await client.billingPortal.configurations.retrieve(policy.catalog.portalConfigurationId)
        test(config)
        if (!config.active || !config.features.payment_method_update.enabled || !config.features.invoice_history.enabled || config.features.subscription_update.enabled || !config.features.subscription_cancel.enabled || config.features.subscription_cancel.mode !== 'at_period_end' || config.features.subscription_cancel.proration_behavior !== 'none') hostingFail('HOSTING_STRIPE_PORTAL_POLICY_DENIED')
        const result = await client.billingPortal.sessions.create({ customer, configuration: config.id, return_url: `${policy.catalog.origin}/settings/billing` }, options)
        if (result.customer !== customer) hostingFail('HOSTING_STRIPE_OBJECT_MISMATCH')
        return { objectId: result.id, url: providerUrl(result.url, 'billing.stripe.com'), expiresAt: new Date(requiredTime(command.firstSentAt).getTime() + 5 * 60_000) }
    }
    async function checkout(id: string, customerId: string) {
        await account()
        const session = await client.checkout.sessions.retrieve(id)
        test(session)
        if (stripeId(session.customer) !== customerId || session.mode !== 'subscription') hostingFail('HOSTING_STRIPE_OBJECT_MISMATCH')
        return { status: session.status, subscriptionId: stripeId(session.subscription) }
    }
    async function snapshot({ customerId, previousSubscriptionId, chargeIds }: { customerId: string, previousSubscriptionId: string | null, chargeIds: string[] }) {
        await account()
        const customer = await client.customers.retrieve(customerId)
        if (customer.deleted) hostingFail('HOSTING_STRIPE_CUSTOMER_DELETED')
        test(customer)
        const charges: ChargeEvidence[] = []
        try {
            if (chargeIds.length > 128) hostingFail('HOSTING_STRIPE_RECONCILIATION_LIMIT')
            const deadline = Date.now() + 120_000
            for (const id of chargeIds) {
                if (Date.now() > deadline) hostingFail('HOSTING_STRIPE_RECONCILIATION_DEADLINE')
                charges.push(await charge(id, customerId))
            }
            const subscriptions = await client.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
            complete(subscriptions)
            const live = subscriptions.data.filter(value => !['canceled', 'incomplete_expired'].includes(value.status))
            if (live.length > 1) hostingFail('HOSTING_STRIPE_DUPLICATE_SUBSCRIPTIONS')
            const sub = live[0] ?? (previousSubscriptionId ? await client.subscriptions.retrieve(previousSubscriptionId) : null)
            let period: PaidPeriodEvidence | null = null
            let selectedPlanId: 'starter' | 'team' | 'scale' | null = null
            let pendingPlan: { planId: 'starter' | 'team' | 'scale', effectiveAt: number, commandId: string } | null = null
            if (sub) {
                test(sub)
                if (stripeId(sub.customer) !== customerId || sub.items.has_more || sub.items.data.length !== 1 || sub.pause_collection || sub.pending_update || sub.schedule || sub.trial_start || sub.trial_end || sub.discounts.length || sub.collection_method !== 'charge_automatically') hostingFail('HOSTING_STRIPE_SUBSCRIPTION_UNSUPPORTED')
                if (!['active', 'canceled', 'incomplete_expired'].includes(sub.status)) hostingFail('HOSTING_STRIPE_PAYMENT_REQUIRED')
                const item = sub.items.data[0]
                const selected = (['starter', 'team', 'scale'] as const).find(plan => policy.catalog.plans[plan].priceId === item.price.id)
                selectedPlanId = selected ?? null
                if (!selected || item.quantity !== 1) hostingFail('HOSTING_STRIPE_PRICE_DENIED')
                await price(policy.catalog.plans[selected])
                if (sub.latest_invoice) {
                    const invoice = await client.invoices.retrieve(requiredId(sub.latest_invoice))
                    if (invoice.status === 'paid') {
                        period = await paid(invoice, sub, item, selected)
                        if (period.planId !== selected) {
                            if (sub.metadata.hostingNextPlan !== selected || !sub.metadata.hostingPlanChangeCommandId) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_UNVERIFIED')
                            pendingPlan = { planId: selected, effectiveAt: item.current_period_end, commandId: sub.metadata.hostingPlanChangeCommandId }
                        }
                    }
                    else if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') hostingFail('HOSTING_STRIPE_PAYMENT_REQUIRED')
                }
            }
            if (period && !charges.some(value => value.id === period.chargeId)) {
                if (charges.length >= 128) hostingFail('HOSTING_STRIPE_RECONCILIATION_LIMIT')
                charges.push(await charge(period.chargeId, customerId))
            }
            return { customerPlatformId: customer.metadata.hostingPlatformId, subscriptionId: sub?.id ?? null, subscriptionStatus: sub?.status ?? null, planChangeCommandId: sub?.metadata.hostingPlanChangeCommandId ?? null, commandId: sub?.metadata.hostingCommandId ?? null, subscriptionPlatformId: sub?.metadata.hostingPlatformId ?? null, period, pendingPlan, selectedPlanId, cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false, charges, issues: [] as string[] }
        }
        catch (error) {
            return { customerPlatformId: customer.metadata.hostingPlatformId, subscriptionId: previousSubscriptionId, subscriptionStatus: null, commandId: null, subscriptionPlatformId: null, period: null, charges, issues: [error instanceof HostingError ? error.message : 'HOSTING_STRIPE_READ_FAILED'] }
        }
    }

    async function paid(invoice: Stripe.Invoice, sub: Stripe.Subscription, item: Stripe.SubscriptionItem, planId: 'starter' | 'team' | 'scale'): Promise<PaidPeriodEvidence> {
        test(invoice)
        const invoiceId = requiredId(invoice)
        const lines = await client.invoices.listLineItems(invoiceId, { limit: 100 })
        complete(lines)
        if (lines.data.length !== 1) hostingFail('HOSTING_STRIPE_INVOICE_UNSUPPORTED')
        const line = lines.data[0]
        const invoicePlan = (['starter', 'team', 'scale'] as const).find(plan => policy.catalog.plans[plan].priceId === stripeId(line.pricing?.price_details?.price))
        if (!invoicePlan || (invoicePlan !== planId && (sub.metadata.hostingNextPlan !== planId || !sub.metadata.hostingPlanChangeCommandId))) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_UNVERIFIED')
        planId = invoicePlan
        const expected = policy.catalog.plans[planId]
        await price(expected)
        const details = line.parent?.subscription_item_details
        if (stripeId(invoice.customer) !== stripeId(sub.customer) || stripeId(invoice.parent?.subscription_details?.subscription) !== sub.id || !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason ?? '') || invoice.amount_remaining !== 0 || invoice.amount_paid <= 0 || invoice.amount_paid !== invoice.total || invoice.amount_due !== invoice.total || invoice.starting_balance !== 0 || invoice.pre_payment_credit_notes_amount || invoice.post_payment_credit_notes_amount || invoice.currency !== expected.currency || invoice.discounts.length || line.livemode || line.invoice !== invoice.id || line.quantity !== 1 || line.amount !== expected.amountMinor || line.currency !== expected.currency || (line.discount_amounts?.length ?? 0) || (line.pretax_credit_amounts?.length ?? 0) || details?.proration !== false || details.subscription_item !== item.id || details.subscription !== sub.id || stripeId(line.pricing?.price_details?.price) !== expected.priceId || line.period.start !== item.current_period_start || line.period.end !== item.current_period_end || line.period.end <= line.period.start || line.period.end - line.period.start > 32 * 86400 || line.period.end - line.period.start < 27 * 86400) hostingFail('HOSTING_STRIPE_INVOICE_UNSUPPORTED')
        const payments = await client.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 100 })
        complete(payments)
        if (payments.data.length !== 1) hostingFail('HOSTING_STRIPE_PAYMENT_UNSUPPORTED')
        const payment = payments.data[0]
        test(payment)
        if (requiredId(payment.invoice) !== invoice.id || payment.amount_paid !== invoice.total || payment.amount_requested !== invoice.total || payment.currency !== invoice.currency || payment.payment.type !== 'payment_intent') hostingFail('HOSTING_STRIPE_PAYMENT_UNSUPPORTED')
        const intent = await client.paymentIntents.retrieve(requiredId(payment.payment.payment_intent))
        test(intent)
        if (intent.status !== 'succeeded' || intent.amount_received !== invoice.total || intent.amount !== invoice.total || intent.currency !== invoice.currency || stripeId(intent.customer) !== stripeId(invoice.customer)) hostingFail('HOSTING_STRIPE_PAYMENT_UNSUPPORTED')
        const charged = await client.charges.retrieve(requiredId(intent.latest_charge))
        test(charged)
        if (stripeId(charged.payment_intent) !== intent.id || stripeId(charged.customer) !== stripeId(invoice.customer) || charged.payment_method_details?.type !== 'card' || charged.status !== 'succeeded' || !charged.paid || !charged.captured || charged.amount !== invoice.total || charged.amount_captured !== invoice.total || charged.currency !== invoice.currency) hostingFail('HOSTING_STRIPE_PAYMENT_UNSUPPORTED')
        return { subscriptionId: sub.id, itemId: item.id, priceId: expected.priceId, planId, start: line.period.start, end: line.period.end, invoiceId, lineId: line.id, chargeId: charged.id }
    }
    async function charge(id: string, customerId: string): Promise<ChargeEvidence> {
        const value = await client.charges.retrieve(id)
        test(value)
        if (stripeId(value.customer) !== customerId || !value.paid || !value.captured) hostingFail('HOSTING_STRIPE_CHARGE_MISMATCH')
        const refunds = await client.refunds.list({ charge: id, limit: 100 })
        const disputes = await client.disputes.list({ charge: id, limit: 100 })
        complete(refunds); complete(disputes)
        for (const refund of refunds.data) {
            if (stripeId(refund.charge) !== id || refund.currency !== value.currency) hostingFail('HOSTING_STRIPE_CHARGE_MISMATCH')
        }
        for (const dispute of disputes.data) {
            test(dispute); if (stripeId(dispute.charge) !== id || dispute.currency !== value.currency) hostingFail('HOSTING_STRIPE_CHARGE_MISMATCH')
        }
        if (refunds.data.filter(refund => refund.status === 'succeeded').reduce((sum, refund) => sum + refund.amount, 0) !== value.amount_refunded || value.refunded !== (value.amount_refunded === value.amount)) hostingFail('HOSTING_STRIPE_REFUND_UNVERIFIED')
        return { id, refunded: value.refunded, lost: disputes.data.some(dispute => dispute.status === 'lost'), holds: disputes.data.filter(dispute => !['won', 'lost', 'warning_closed'].includes(dispute.status)).map(dispute => `dispute:${dispute.id}`) }
    }
    async function price(expected: HostedStripeCatalog['plans']['starter']): Promise<void> {
        const value = await client.prices.retrieve(expected.priceId)
        test(value)
        if (!value.active || value.type !== 'recurring' || value.recurring?.interval !== 'month' || value.recurring.interval_count !== 1 || value.recurring.usage_type !== 'licensed' || value.unit_amount !== expected.amountMinor || value.currency !== expected.currency || value.billing_scheme !== 'per_unit' || value.transform_quantity) hostingFail('HOSTING_STRIPE_PRICE_DENIED')
    }
    // Read-only validation for an explicit catalog-only migration. It never
    // creates a customer/session, updates a subscription or supplies a grant.
    async function catalogEvidence(input: { customerId: string | null, subscriptionId: string | null, chargeIds: string[] }) {
        await account()
        for (const expected of Object.values(policy.catalog.plans)) await price(expected)
        const config = await client.billingPortal.configurations.retrieve(policy.catalog.portalConfigurationId)
        test(config)
        if (!config.active || !config.features.payment_method_update.enabled || !config.features.invoice_history.enabled || config.features.subscription_update.enabled || !config.features.subscription_cancel.enabled || config.features.subscription_cancel.mode !== 'at_period_end' || config.features.subscription_cancel.proration_behavior !== 'none') hostingFail('HOSTING_STRIPE_PORTAL_POLICY_DENIED')
        if (!input.customerId) {
            if (input.subscriptionId || input.chargeIds.length) hostingFail('HOSTING_STRIPE_OBJECT_MISMATCH')
            return { customerPlatformId: null, subscriptionPlatformId: null, subscriptionId: null, subscriptionStatus: null, commandId: null, period: null, charges: [], issues: [] }
        }
        return snapshot({ customerId: input.customerId, previousSubscriptionId: input.subscriptionId, chargeIds: input.chargeIds })
    }
    async function catalogCommandEvidence(commands: StripeCommand[], customerId: string | null, subscriptionId: string | null) {
        await account()
        const observations: { commandId: string, objectId: string | null, reason: string }[] = []
        for (const row of commands.filter(value => value.kind === 'customer' && value.state === 'ready')) if (row.objectId !== customerId || row.payloadHash !== stripeDigest(row.payload)) hostingFail('HOSTING_STRIPE_CATALOG_COMMAND_INVALID')
        for (const command of commands.filter(value => value.state !== 'closed' && !(value.kind === 'customer' && value.state === 'ready'))) {
            if (command.payloadHash !== stripeDigest(command.payload)) hostingFail('HOSTING_STRIPE_CATALOG_COMMAND_INVALID')
            if (command.state === 'prepared' && !command.firstSentAt && !command.objectId && !command.fence && !command.leaseUntil) {
                observations.push({ commandId: command.id, objectId: null, reason: 'never_sent' })
                continue
            }
            if (command.state !== 'ready' || !command.firstSentAt || !command.objectId || !customerId || command.payload.customerId !== customerId) hostingFail('HOSTING_STRIPE_CATALOG_OPEN_COMMANDS')
            if (command.kind === 'plan_change') {
                if (command.objectId !== subscriptionId) hostingFail('HOSTING_STRIPE_CATALOG_OPEN_COMMANDS')
                observations.push({ commandId: command.id, objectId: command.objectId, reason: 'plan_change_delivery_retired' })
                continue
            }
            if (command.kind === 'portal') {
                // This retires only our delivery of the old URL. Stripe has no
                // portal-session retrieve/revoke API. Its existing customer
                // access and cancellation rights remain in force.
                observations.push({ commandId: command.id, objectId: command.objectId, reason: 'portal_delivery_retired' })
                continue
            }
            if (command.kind !== 'checkout') hostingFail('HOSTING_STRIPE_CATALOG_OPEN_COMMANDS')
            const session = await checkout(command.objectId, customerId)
            if (session.status === 'expired' || (session.status === 'complete' && session.subscriptionId && session.subscriptionId === subscriptionId)) observations.push({ commandId: command.id, objectId: command.objectId, reason: session.status === 'expired' ? 'checkout_expired' : 'checkout_completed' })
            else hostingFail('HOSTING_STRIPE_CATALOG_OPEN_COMMANDS')
        }
        return observations
    }
    async function eventCustomer(eventId: string): Promise<string | null> {
        await account()
        const event = await client.events.retrieve(eventId)
        assertStripeEventEnvelope(event)
        const object = event.data.object
        if ('customer' in object) return stripeId(object.customer)
        if ('charge' in object) {
            const value = await client.charges.retrieve(requiredId(object.charge)); test(value); return stripeId(value.customer)
        }
        return null
    }
    return { verify, create, checkout, snapshot, eventCustomer, catalogEvidence, catalogCommandEvidence }
}
function complete(value: { has_more: boolean }): void {
    if (value.has_more) hostingFail('HOSTING_STRIPE_PAGINATION_UNSUPPORTED')
}
function test(value: { livemode: boolean }): void {
    if (value.livemode !== false) hostingFail('HOSTING_STRIPE_LIVE_OBJECT_DENIED')
}
function requiredId(value: string | { id?: string } | null | undefined): string {
    const id = stripeId(value); if (!id) hostingFail('HOSTING_STRIPE_OBJECT_MISMATCH'); return id
}
function requiredTime(value: Date | null): Date {
    if (!value) hostingFail('HOSTING_STRIPE_COMMAND_UNCLAIMED'); return value
}
function providerUrl(value: string, host: string): string {
    const url = new URL(value); if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port) hostingFail('HOSTING_STRIPE_URL_DENIED'); return value
}
