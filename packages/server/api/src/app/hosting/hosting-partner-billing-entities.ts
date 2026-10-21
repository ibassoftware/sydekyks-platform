import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type Base = { id: string, created: Date, updated: Date }
export type PartnerPackage = 'core' | 'guided'
export type PartnerPurchase = Base & {
    platformId: string
    identityId: string
    tokenVersion: string | null
    courseId: string
    package: PartnerPackage
    stripeAccountId: string
    policyHash: string
    priceId: string
    amountMinor: number
    state: 'prepared' | 'ready' | 'fulfilled' | 'refunded' | 'expired' | 'review'
    customerId: string | null
    sessionId: string | null
    checkoutUrl: string | null
    expiresAt: Date | null
    firstSentAt: Date | null
    fence: string | null
    leaseUntil: Date | null
    reconcileAt: Date
    chargeId: string | null
    paymentIntentId: string | null
    enrollmentId: string | null
    trainingId: string | null
    refundedMinor: number
    revision: number
    reason: string | null
}
export type PartnerPurchaseAudit = Base & { purchaseId: string, revision: number, event: string, evidence: Record<string, unknown> }
const date = { type: 'timestamptz' as const, nullable: true }
const nullableString = { type: String, nullable: true }
export const HostingPartnerPurchaseEntity = new EntitySchema<PartnerPurchase>({
    name: 'hosting_partner_purchase',
    columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, identityId: ApIdSchema, tokenVersion: nullableString, courseId: ApIdSchema,
        package: { type: String }, stripeAccountId: { type: String }, policyHash: { type: String, length: 64 }, priceId: { type: String }, amountMinor: { type: Number }, state: { type: String },
        customerId: nullableString, sessionId: nullableString, checkoutUrl: nullableString, expiresAt: date, firstSentAt: date, fence: nullableString, leaseUntil: date, reconcileAt: { type: 'timestamptz' },
        chargeId: nullableString, paymentIntentId: nullableString, enrollmentId: { ...ApIdSchema, nullable: true }, trainingId: { ...ApIdSchema, nullable: true },
        refundedMinor: { type: Number, default: 0 }, revision: { type: Number, default: 0 }, reason: nullableString,
    },
    indices: [{ name: 'uq_partner_purchase_active_workspace', columns: ['platformId'], unique: true, where: 'state <> \'expired\'' }, { name: 'idx_partner_purchase_reconcile', columns: ['reconcileAt'] }],
    uniques: [{ columns: ['sessionId'] }, { columns: ['chargeId'] }, { columns: ['enrollmentId'] }, { columns: ['trainingId'] }],
    foreignKeys: [{ target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'user_identity', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HostingPartnerPurchaseAuditEntity = new EntitySchema<PartnerPurchaseAudit>({
    name: 'hosting_partner_purchase_audit', columns: { ...BaseColumnSchemaPart, purchaseId: ApIdSchema, revision: { type: Number }, event: { type: String }, evidence: { type: 'jsonb' } },
    uniques: [{ columns: ['purchaseId', 'revision'] }],
    foreignKeys: [{ target: 'hosting_partner_purchase', columnNames: ['purchaseId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HOSTING_PARTNER_BILLING_ENTITIES = [HostingPartnerPurchaseEntity, HostingPartnerPurchaseAuditEntity]
