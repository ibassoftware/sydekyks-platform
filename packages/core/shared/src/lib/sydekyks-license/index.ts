import { z } from 'zod'

export const SydekyksEntitlement = z.object({
    v: z.literal(1),
    product: z.literal('sydekyks'),
    installationId: z.uuid(),
    customerId: z.uuid(),
    kind: z.enum(['trial', 'commercial']),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    leaseUntil: z.number().int().positive(),
    revoked: z.boolean(),
    revision: z.number().int().positive(),
})

export const SydekyksLicenseStatus = z.object({
    state: z.enum(['active', 'activation_required', 'expired', 'revoked', 'verification_required']),
    kind: z.enum(['trial', 'commercial']).nullable(),
    expiresAt: z.number().nullable(),
    serverTime: z.number(),
    renewalUrl: z.literal('https://www.sydekyks.com/#conversation'),
})

export const SydekyksActivateRequest = z.object({ code: z.string().trim().min(10).max(100) })
export const SydekyksTrialRequest = z.object({
    company: z.string().trim().min(1).max(200),
    email: z.email().max(254),
    phone: z.string().trim().min(3).max(40),
    registrationAccepted: z.literal(true),
})
export const SydekyksVerifyTrialRequest = z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) })
export const SydekyksTrialChallenge = z.object({ challengeId: z.uuid() })

export type SydekyksEntitlement = z.infer<typeof SydekyksEntitlement>
export type SydekyksLicenseStatus = z.infer<typeof SydekyksLicenseStatus>
export type SydekyksActivateRequest = z.infer<typeof SydekyksActivateRequest>
export type SydekyksTrialRequest = z.infer<typeof SydekyksTrialRequest>
export type SydekyksVerifyTrialRequest = z.infer<typeof SydekyksVerifyTrialRequest>

export type SydekyksTrialChallenge = z.infer<typeof SydekyksTrialChallenge>
