import { z } from 'zod'

const id = z.string().length(21)
const date = z.iso.datetime()
export const HostedSubscriptionUpdate = z.strictObject({
    platformId: id,
    expectedRevision: z.number().int().nonnegative(),
    requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
    renewalDueAt: date.nullable(),
    reason: z.string().trim().min(1).max(500),
})
export type HostedSubscriptionUpdate = z.infer<typeof HostedSubscriptionUpdate>
export const HostedSubscriptionView = z.object({
    platformId: id, userId: id, scopePlatformId: id, name: z.string(),
    planId: z.enum(['trial', 'training', 'assessment', 'starter', 'team']),
    accountStatus: z.enum(['trialing', 'active', 'suspended']), billingHold: z.boolean(),
    revision: z.number().int().nonnegative(), origin: z.enum(['fixed', 'paid_default', 'override']), serverTime: date,
    renewalDueAt: date.nullable(), graceEndsAt: date.nullable(),
    state: z.enum(['unmanaged', 'current', 'grace', 'overdue', 'review_required']),
    effectiveRuntimeUntil: date, canManage: z.boolean(),
    limitation: z.enum(['funded_entitlement_required', 'entitlement_changed']).nullable(),
    boundPeriod: z.object({ sourceKey: z.string(), planId: z.enum(['training', 'starter', 'team']), validFrom: date, originalValidUntil: date, executionGrantId: id, managedAiGrantId: id }).nullable(),
})
export type HostedSubscriptionView = z.infer<typeof HostedSubscriptionView>
