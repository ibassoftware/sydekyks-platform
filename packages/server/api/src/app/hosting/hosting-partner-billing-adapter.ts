import type Stripe from 'stripe'
import { z } from 'zod'
import { PartnerPurchase } from './hosting-partner-billing-entities'
import { readStripePolicy, STRIPE_API_VERSION, stripeDigest, stripeId } from './hosting-stripe-policy'
import { hostingFail } from './hosting-transactions'

const packagePrice = z.strictObject({ priceId: z.string().regex(/^price_[a-zA-Z0-9]+$/), amountMinor: z.number().int(), currency: z.literal('usd') })
const partnerCatalog = z.object({ partnerCourseId: z.string().length(21), partnerPackages: z.strictObject({ core: packagePrice.extend({ amountMinor: z.literal(100000) }), guided: packagePrice.extend({ amountMinor: z.literal(120000) }) }) })
export function readPartnerStripePolicy() {
    const base = readStripePolicy()
    const parsed = partnerCatalog.safeParse(base.catalog)
    if (!parsed.success) hostingFail('HOSTING_PARTNER_CHECKOUT_UNCONFIGURED')
    if (parsed.data.partnerPackages.core.priceId === parsed.data.partnerPackages.guided.priceId || Object.values(parsed.data.partnerPackages).some(price => Object.values(base.catalog.plans).some(plan => plan.priceId === price.priceId))) hostingFail('HOSTING_PARTNER_PRICE_DENIED')
    return { ...base, ...parsed.data, hash: stripeDigest({ accountId: base.catalog.accountId, origin: base.catalog.origin, ...parsed.data }) }
}
export type PartnerStripePolicy = ReturnType<typeof readPartnerStripePolicy>
export type PartnerPaymentEvidence = { status: 'open' | 'expired' } | { status: 'paid', sessionId: string, customerId: string, paymentIntentId: string, chargeId: string, amountMinor: number, refundedMinor: number, evidenceHash: string }
export function partnerMetadata(purchase: PartnerPurchase) {
    return { hostingPartnerPurchaseId: purchase.id, hostingPlatformId: purchase.platformId, hostingIdentityId: purchase.identityId, hostingCourseId: purchase.courseId, hostingPartnerPackage: purchase.package }
}
export async function createPartnerStripeAdapter(policy: Pick<PartnerStripePolicy, 'secret' | 'signingSecret' | 'catalog' | 'hash'> & Partial<Pick<PartnerStripePolicy, 'partnerPackages' | 'partnerCourseId'>>) {
    const { default: StripeSdk } = await import('stripe')
    const client = new StripeSdk(policy.secret, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 15000 })
    async function merchant() {
        if ((await client.accounts.retrieve()).id !== policy.catalog.accountId) hostingFail('HOSTING_STRIPE_ACCOUNT_MISMATCH')
    }
    async function price(row: PartnerPurchase, historical = false) {
        if (row.stripeAccountId !== policy.catalog.accountId || !['core', 'guided'].includes(row.package) || row.amountMinor !== (row.package === 'core' ? 100000 : 120000)) hostingFail('HOSTING_PARTNER_POLICY_CHANGED')
        const expected = policy.partnerPackages?.[row.package]
        if (!historical && (!expected || row.policyHash !== policy.hash || row.courseId !== policy.partnerCourseId || row.priceId !== expected.priceId || row.amountMinor !== expected.amountMinor)) hostingFail('HOSTING_PARTNER_POLICY_CHANGED')
        const value = await client.prices.retrieve(row.priceId)
        test(value)
        if ((!historical && !value.active) || value.id !== row.priceId || value.type !== 'one_time' || value.recurring || value.currency !== 'usd' || value.unit_amount !== row.amountMinor || value.billing_scheme !== 'per_unit' || value.transform_quantity || value.custom_unit_amount || value.tiers_mode) hostingFail('HOSTING_PARTNER_PRICE_DENIED')
    }
    async function customer(row: PartnerPurchase) {
        await merchant(); await price(row)
        const value = await client.customers.create({ metadata: partnerMetadata(row) }, { idempotencyKey: `partner:test:${policy.catalog.accountId}:customer:${row.id}` })
        test(value); metadata(value.metadata, row)
        return value.id
    }
    async function create(row: PartnerPurchase) {
        await merchant(); await price(row)
        if (!row.customerId || !row.firstSentAt) hostingFail('HOSTING_PARTNER_COMMAND_INVALID')
        const owner = await client.customers.retrieve(row.customerId)
        if (owner.deleted) hostingFail('HOSTING_STRIPE_CUSTOMER_DELETED')
        test(owner); metadata(owner.metadata, row)
        const binding = partnerMetadata(row)
        const value = await client.checkout.sessions.create({ customer: row.customerId, mode: 'payment', payment_method_types: ['card'], line_items: [{ price: row.priceId, quantity: 1 }], allow_promotion_codes: false, automatic_tax: { enabled: false }, client_reference_id: row.platformId, metadata: binding, payment_intent_data: { metadata: binding }, success_url: `${policy.catalog.origin}/settings/billing?checkout=success`, cancel_url: `${policy.catalog.origin}/settings/billing?checkout=cancel`, expires_at: Math.floor(row.firstSentAt.getTime() / 1000) + 3600 }, { idempotencyKey: `partner:test:${policy.catalog.accountId}:checkout:${row.id}` })
        test(value); metadata(value.metadata, row)
        if (stripeId(value.customer) !== row.customerId || value.mode !== 'payment' || value.client_reference_id !== row.platformId || !value.url) hostingFail('HOSTING_PARTNER_OBJECT_MISMATCH')
        return { sessionId: value.id, checkoutUrl: checkoutUrl(value.url), expiresAt: new Date(value.expires_at * 1000) }
    }
    async function snapshot(row: PartnerPurchase): Promise<PartnerPaymentEvidence> {
        // Existing receipt monitoring must survive price retirement/catalog edits.
        // The immutable stored sale binds its original ID, amount and metadata.
        await merchant(); await price(row, true)
        if (!row.sessionId || !row.customerId) hostingFail('HOSTING_PARTNER_COMMAND_INVALID')
        const owner = await client.customers.retrieve(row.customerId)
        if (owner.deleted) hostingFail('HOSTING_STRIPE_CUSTOMER_DELETED')
        test(owner); metadata(owner.metadata, row)
        const session = await client.checkout.sessions.retrieve(row.sessionId)
        test(session); metadata(session.metadata, row)
        if (session.id !== row.sessionId || stripeId(session.customer) !== row.customerId || session.client_reference_id !== row.platformId || session.mode !== 'payment' || session.subscription || session.currency !== 'usd' || session.amount_subtotal !== row.amountMinor || session.amount_total !== row.amountMinor || session.total_details?.amount_discount !== 0 || session.total_details?.amount_tax !== 0 || (session.total_details?.amount_shipping ?? 0) !== 0) hostingFail('HOSTING_PARTNER_OBJECT_MISMATCH')
        const lines = await client.checkout.sessions.listLineItems(session.id, { limit: 100 })
        if (lines.has_more || lines.data.length !== 1) hostingFail('HOSTING_PARTNER_LINE_ITEMS_DENIED')
        const line = lines.data[0]
        if (line.quantity !== 1 || line.price?.id !== row.priceId || line.currency !== 'usd' || line.amount_subtotal !== row.amountMinor || line.amount_total !== row.amountMinor || line.amount_discount !== 0 || line.amount_tax !== 0) hostingFail('HOSTING_PARTNER_LINE_ITEMS_DENIED')
        if (session.status === 'expired' && session.payment_status !== 'paid') return { status: 'expired' }
        if (session.status === 'open' && session.payment_status !== 'paid') return { status: 'open' }
        if (session.status !== 'complete' || session.payment_status !== 'paid') hostingFail('HOSTING_PARTNER_PAYMENT_UNVERIFIED')
        const intentId = requiredId(session.payment_intent)
        const intent = await client.paymentIntents.retrieve(intentId)
        test(intent); metadata(intent.metadata, row)
        if (intent.status !== 'succeeded' || stripeId(intent.customer) !== row.customerId || intent.currency !== 'usd' || intent.amount !== row.amountMinor || intent.amount_received !== row.amountMinor || !['automatic', 'automatic_async'].includes(intent.capture_method) || !intent.payment_method_types.includes('card')) hostingFail('HOSTING_PARTNER_PAYMENT_UNVERIFIED')
        const charge = await client.charges.retrieve(requiredId(intent.latest_charge))
        test(charge)
        if (stripeId(charge.payment_intent) !== intent.id || stripeId(charge.customer) !== row.customerId || charge.currency !== 'usd' || charge.amount !== row.amountMinor || charge.amount_captured !== row.amountMinor || !charge.paid || !charge.captured || charge.status !== 'succeeded' || charge.payment_method_details?.type !== 'card') hostingFail('HOSTING_PARTNER_PAYMENT_UNVERIFIED')
        const refunds = await client.refunds.list({ charge: charge.id, limit: 100 })
        if (refunds.has_more) hostingFail('HOSTING_PARTNER_REFUND_UNVERIFIED')
        for (const refund of refunds.data) {
            if (stripeId(refund.charge) !== charge.id || stripeId(refund.payment_intent) !== intent.id || refund.currency !== 'usd' || refund.amount <= 0) hostingFail('HOSTING_PARTNER_REFUND_UNVERIFIED')
        }
        const refundedMinor = refunds.data.filter(refund => refund.status === 'succeeded').reduce((sum, refund) => sum + refund.amount, 0)
        if (refundedMinor !== charge.amount_refunded || refundedMinor > row.amountMinor || charge.refunded !== (refundedMinor === row.amountMinor)) hostingFail('HOSTING_PARTNER_REFUND_UNVERIFIED')
        const evidence = { status: 'paid' as const, sessionId: session.id, customerId: owner.id, paymentIntentId: intent.id, chargeId: charge.id, amountMinor: row.amountMinor, refundedMinor }
        return { ...evidence, evidenceHash: stripeDigest(evidence) }
    }
    return { customer, create, snapshot }
}
function metadata(value: Stripe.Metadata | null, row: PartnerPurchase): void {
    if (!value || Object.entries(partnerMetadata(row)).some(([key, expected]) => value[key] !== expected)) hostingFail('HOSTING_PARTNER_METADATA_MISMATCH')
}
function test(value: { livemode?: boolean }): void {
    if (value.livemode !== false) hostingFail('HOSTING_STRIPE_LIVE_OBJECT_DENIED')
}
function requiredId(value: string | { id?: string } | null | undefined): string {
    const id = stripeId(value)
    if (!id) hostingFail('HOSTING_PARTNER_PAYMENT_UNVERIFIED')
    return id
}
function checkoutUrl(raw: string): string {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password) hostingFail('HOSTING_STRIPE_PROVIDER_URL_DENIED')
    return url.href
}
