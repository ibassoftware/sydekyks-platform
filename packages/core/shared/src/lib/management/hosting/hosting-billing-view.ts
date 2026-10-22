import { z } from 'zod'

const quantity = z.string().regex(/^\d{1,30}$/)
const date = z.iso.datetime()
export const HostedBillingActionReason = z.enum(['manual_billing', 'billing_unavailable', 'account_paused', 'billing_review', 'resource_limit', 'subscription_exists', 'checkout_pending', 'session_changed', 'recovery_required', 'customer_missing', 'sales_assisted'])
const action = z.object({ enabled: z.boolean(), reason: HostedBillingActionReason.nullable(), continuing: z.boolean() })
const meter = z.object({ state: z.enum(['active', 'expired', 'revoked', 'missing']), amount: quantity, consumed: quantity, reserved: quantity, available: quantity, validFrom: date.nullable(), validUntil: date.nullable() })
const limits = z.object({ users: z.number().int().nonnegative(), projects: z.number().int().nonnegative(), executions: z.number().int().nonnegative(), concurrency: z.number().int().nonnegative(), aiCredits: z.number().int().nonnegative(), byokEnabled: z.literal(true) })
export const HostedBillingOverview = z.object({
    schemaVersion: z.literal(1), platformId: z.string(), userId: z.string(), catalogVersion: z.string(), serverTime: date,
    billingMode: z.enum(['manual', 'stripe_test']).default('manual'), environment: z.enum(['manual', 'test']), planId: z.enum(['trial', 'training', 'assessment', 'starter', 'team', 'scale']), status: z.enum(['trialing', 'active', 'suspended']),
    entitlementState: z.enum(['trial', 'training', 'assessment', 'paid', 'expired', 'paused']), validUntil: date, trialEndsAt: date, billingHold: z.boolean(),
    accountKind: z.enum(['platform_admin', 'partner', 'client', 'trial']).optional(),
    trainingPackage: z.enum(['core', 'launch']).nullable().optional(),
    hostingEndsAt: date.nullable().optional(), renewalDueAt: date.nullable().optional(), nextCreditAllowanceAt: date.nullable().optional(),
    manualFunding: z.boolean().optional(),
    subscriptionStatus: z.string().nullable(), planChangesEnabled: z.boolean(),
    pendingPlanId: z.enum(['starter', 'team', 'scale']).nullable().optional(), pendingChangeAt: date.nullable().optional(), cancelAtPeriodEnd: z.boolean().optional(),
    notice: z.enum(['account_paused', 'billing_review', 'billing_delayed']).nullable(),
    meters: z.object({ execution: meter, managedAi: meter, previousPeriodHeldMicroUsd: quantity }),
    usage: z.object({ users: z.number().int().nonnegative(), projects: z.number().int().nonnegative(), pendingUsers: z.number().int().nonnegative(), pendingProjects: z.number().int().nonnegative(), activeExecutions: z.number().int().nonnegative() }),
    limits,
    plans: z.array(z.object({ id: z.enum(['starter', 'team', 'scale']), limits, salesAssisted: z.boolean().default(false), price: z.object({ amountMinor: z.number().int().positive().max(100_000_000), currency: z.string().regex(/^[a-z]{3}$/), interval: z.literal('month') }).nullable(), checkout: action })).length(3),
    portal: action,
})
export type HostedBillingOverview = z.infer<typeof HostedBillingOverview>
// One customer Credits wallet funds executions and managed AI. Legacy AI meters
// remain available only in the internal compatibility view, never as an allowance.
export const HostedCustomerBillingOverview = HostedBillingOverview.extend({
    meters: z.object({ execution: meter }),
    limits: limits.omit({ aiCredits: true }),
    plans: z.array(HostedBillingOverview.shape.plans.element.extend({ limits: limits.omit({ aiCredits: true }) })).length(3),
})
export type HostedCustomerBillingOverview = z.infer<typeof HostedCustomerBillingOverview>
export type HostedBillingActionReason = z.infer<typeof HostedBillingActionReason>
export const HOSTED_MICRO_USD_PER_CREDIT = BigInt(1000)
