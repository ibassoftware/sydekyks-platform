import { z } from 'zod'

export const HostedOnboardingOffer = z.object({
    catalogVersion: z.string(),
    emailCodesAvailable: z.boolean(),
    trialDays: z.number().int().positive(),
    trial: z.object({ users: z.number().int().positive(), projects: z.number().int().positive(), executions: z.number().int().positive(), concurrency: z.number().int().positive(), aiCredits: z.number().int().nonnegative(), byokEnabled: z.literal(true) }),
})
export type HostedOnboardingOffer = z.infer<typeof HostedOnboardingOffer>
export const HostedOnboardingStatus = z.object({
    platformId: z.string(), userId: z.string(), platformName: z.string(), firstName: z.string(), isAdmin: z.boolean(),
    planId: z.enum(['trial', 'starter', 'team']), entitlementState: z.enum(['trial', 'paid', 'expired', 'paused']),
    validUntil: z.iso.datetime(), serverTime: z.iso.datetime(),
})
export type HostedOnboardingStatus = z.infer<typeof HostedOnboardingStatus>
