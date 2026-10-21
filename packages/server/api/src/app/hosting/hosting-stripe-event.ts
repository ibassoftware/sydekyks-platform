import { z } from 'zod'
import { STRIPE_API_VERSION } from './hosting-stripe-policy'
import { hostingFail } from './hosting-transactions'

// Webhook envelopes only route invalidation. Payment authority is always read
// afresh with the pinned Basil API and exact merchant/price/charge checks.
const envelope = z.object({ id: z.string().regex(/^evt_[a-zA-Z0-9]+$/), type: z.string().min(1).max(128), created: z.number().int().nonnegative(), livemode: z.literal(false), api_version: z.enum([STRIPE_API_VERSION, '2020-08-27']), account: z.never().optional(), context: z.never().optional(), data: z.object({ object: z.object({ id: z.string().regex(/^[a-z][a-z0-9]*_[a-zA-Z0-9_]+$/), object: z.string().min(1).max(128) }).passthrough() }) })
export function assertStripeEventEnvelope(value: unknown): void {
    const parsed = envelope.safeParse(value)
    if (!parsed.success) hostingFail('HOSTING_STRIPE_EVENT_CONTEXT_DENIED')
    const event = parsed.data, object = event.data.object
    const kind = event.type.startsWith('checkout.session.') ? ['checkout.session', /^cs_(test_)?[a-zA-Z0-9]+$/] as const
        : event.type.startsWith('customer.subscription.') ? ['subscription', /^sub_[a-zA-Z0-9]+$/] as const
            : event.type.startsWith('invoice.') ? ['invoice', /^in_[a-zA-Z0-9]+$/] as const
                : event.type.startsWith('charge.dispute.') ? ['dispute', /^dp_[a-zA-Z0-9]+$/] as const
                    : event.type.startsWith('charge.') ? ['charge', /^ch_[a-zA-Z0-9]+$/] as const
                        : event.type.startsWith('refund.') ? ['refund', /^re_[a-zA-Z0-9]+$/] as const
                            : event.type.startsWith('credit_note.') ? ['credit_note', /^cn_[a-zA-Z0-9]+$/] as const : null
    if (kind && (object.object !== kind[0] || !kind[1].test(object.id))) hostingFail('HOSTING_STRIPE_EVENT_CONTEXT_DENIED')
    for (const [field, pattern] of [['customer', /^cus_[a-zA-Z0-9]+$/], ['charge', /^ch_[a-zA-Z0-9]+$/]] as const) {
        if (field in object && object[field] !== null) {
            const reference = object[field]
            const id = typeof reference === 'string' ? reference : typeof reference === 'object' && reference && 'id' in reference ? reference.id : null
            if (typeof id !== 'string' || !pattern.test(id)) hostingFail('HOSTING_STRIPE_EVENT_CONTEXT_DENIED')
        }
    }
    if (event.type === 'charge.refunded' && typeof object.refunded !== 'boolean') hostingFail('HOSTING_STRIPE_EVENT_CONTEXT_DENIED')
    if (event.type.startsWith('charge.dispute.') && (typeof object.status !== 'string' || !['warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost', 'prevented'].includes(object.status))) hostingFail('HOSTING_STRIPE_EVENT_CONTEXT_DENIED')
}
