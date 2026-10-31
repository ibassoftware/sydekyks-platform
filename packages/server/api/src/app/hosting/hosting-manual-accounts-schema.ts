import { HOSTED_PARTNER_STARTER_MONTHLY_CREDITS, MAX_FULL_NAME_LENGTH, PasswordType } from '@activepieces/shared'
import { z } from 'zod'

const requestKey = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/)
const reason = z.string().trim().min(3).max(500)
const monthlyCredits = z.number().int().min(0).max(1_000_000).optional()
const expiresAt = z.iso.datetime({ offset: true })
const common = {
    requestKey, companyName: z.string().trim().min(1).max(120), fullName: z.string().trim().min(1).max(MAX_FULL_NAME_LENGTH),
    email: z.email().max(254).transform(value => value.trim().toLowerCase()), password: PasswordType, monthlyCredits, reason,
}
export const HostingManualAccountCreate = z.discriminatedUnion('kind', [
    z.strictObject({ ...common, expiresAt: expiresAt.optional(), kind: z.literal('partner'), planId: z.literal('training'), partner: z.strictObject({ package: z.enum(['starter', 'core', 'launch']), courseId: z.string().length(21).optional(), approve: z.boolean().default(false) }) }),
    z.strictObject({ ...common, expiresAt, kind: z.literal('client'), planId: z.enum(['starter', 'team', 'scale']) }),
]).superRefine((value, context) => {
    if (value.kind !== 'partner' || value.partner.package !== 'starter') return
    if ((value.monthlyCredits ?? HOSTED_PARTNER_STARTER_MONTHLY_CREDITS) > HOSTED_PARTNER_STARTER_MONTHLY_CREDITS) context.addIssue({ code: 'custom', path: ['monthlyCredits'], message: 'Partner Starter is capped at 35 Credits per month.' })
    if (value.partner.courseId) context.addIssue({ code: 'custom', path: ['partner', 'courseId'], message: 'Partner Starter does not include a training package.' })
})
export const HostingManualTermCreate = z.strictObject({ requestKey, expectedRevision: z.number().int().min(1).max(1000), expiresAt, monthlyCredits, reason })
export type HostingManualAccountCreate = z.input<typeof HostingManualAccountCreate>
export type HostingManualTermCreate = z.input<typeof HostingManualTermCreate>

export const HostingManualEnrollmentCreate = z.strictObject({ requestKey, expectedRevision: z.number().int().min(1).max(1000), courseId: z.string().length(21) })
export type HostingManualEnrollmentCreate = z.input<typeof HostingManualEnrollmentCreate>
