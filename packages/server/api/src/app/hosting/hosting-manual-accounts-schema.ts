import { MAX_FULL_NAME_LENGTH, PasswordType } from '@activepieces/shared'
import { z } from 'zod'

const requestKey = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/)
const reason = z.string().trim().min(3).max(500)
const monthlyCredits = z.number().int().min(0).max(1_000_000).optional()
const expiresAt = z.iso.datetime({ offset: true })
const common = {
    requestKey, companyName: z.string().trim().min(1).max(120), fullName: z.string().trim().min(1).max(MAX_FULL_NAME_LENGTH),
    email: z.email().max(254).transform(value => value.trim().toLowerCase()), password: PasswordType, expiresAt, monthlyCredits, reason,
}
export const HostingManualAccountCreate = z.discriminatedUnion('kind', [
    z.strictObject({ ...common, kind: z.literal('partner'), planId: z.literal('training'), partner: z.strictObject({ package: z.enum(['core', 'launch']), courseId: z.string().length(21).optional(), approve: z.boolean().default(false) }) }),
    z.strictObject({ ...common, kind: z.literal('client'), planId: z.enum(['starter', 'team', 'scale']) }),
])
export const HostingManualTermCreate = z.strictObject({ requestKey, expectedRevision: z.number().int().min(1).max(1000), expiresAt, monthlyCredits, reason })
export type HostingManualAccountCreate = z.input<typeof HostingManualAccountCreate>
export type HostingManualTermCreate = z.input<typeof HostingManualTermCreate>

export const HostingManualEnrollmentCreate = z.strictObject({ requestKey, expectedRevision: z.number().int().min(1).max(1000), courseId: z.string().length(21) })
export type HostingManualEnrollmentCreate = z.input<typeof HostingManualEnrollmentCreate>
