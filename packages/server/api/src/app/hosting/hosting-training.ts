import { apId } from '@activepieces/core-utils'
import { hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager, In } from 'typeorm'
import { z } from 'zod'
import { LmsCourseEntity, LmsEnrollment, LmsEnrollmentEntity } from '../lms/lms-entities'
import { assertHostingOperator } from './hosting-access-policy'
import { revokeAssessmentAccess } from './hosting-assessment'
import { effectiveHostedCredits } from './hosting-credit-allowance'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity, HostingReservationEntity } from './hosting-entities'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { HostingPartnerPurchaseEntity } from './hosting-partner-billing-entities'
import { HostingStripeBindingEntity } from './hosting-stripe-entities'
import { HostingTraining, HostingTrainingEntity } from './hosting-training-entity'
import { newPartnerTrainingPeriods } from './hosting-training-periods'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const bindingSchema = z.strictObject({
    platformId: z.string().length(21), identityId: z.string().length(21), enrollmentId: z.string().length(21),
    receiptId: z.string().trim().min(1).max(180), tier: z.enum(['core', 'launch']),
})
type Binding = z.infer<typeof bindingSchema>

// Defense in depth: neither a browser binding nor another internal caller can
// turn an ordinary/private course enrollment into a hosting-credit entitlement.
export async function assertPartnerTrainingEnrollment(manager: EntityManager, enrollment: LmsEnrollment): Promise<void> {
    const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: enrollment.courseId, status: 'published' })
    if (!course || course.ownerPlatformId !== null || course.audience !== 'partner' || course.certificationMode !== 'partner' || enrollment.accessType !== 'partner_training' || enrollment.grantPlatformId !== null || !enrollment.package || !enrollment.paymentReference?.trim()) hostingFail('HOSTING_PARTNER_TRAINING_REQUIRED')
}

// Internal operator fulfillment API. The caller must load a verified persisted LMS
// enrollment/payment record; course completion or browser payment assertions are not authority.
export function createHostedTraining({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }) {
    async function activateBinding({ actor, ...binding }: Binding & { actor: HostingActor }, purchaseId?: string): Promise<HostingTraining> {
        const input = bindingSchema.parse(binding)
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            if (purchaseId) await assertVerifiedReceipt(manager, purchaseId, binding)
            else await assertHostingOperator({ manager, actor })
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: input.enrollmentId }, lock: { mode: 'pessimistic_write' } })
            if (!enrollment) hostingFail('HOSTING_PARTNER_TRAINING_REQUIRED')
            await assertPartnerTrainingEnrollment(manager, enrollment)
            const now = await tx.now(manager)
            if (enrollment.status !== 'active' || enrollment.startsAt > now || enrollment.accessUntil <= now || enrollment.assessmentUntil <= now || enrollment.identityId !== input.identityId || enrollment.workspacePlatformId !== input.platformId || enrollment.paymentReference !== input.receiptId || enrollment.package !== input.tier) hostingFail('HOSTING_LEARNING_ENROLLMENT_UNAVAILABLE')
            const account = await tx.account({ manager, platformId: input.platformId })
            if (account.ownerIdentityId !== input.identityId) hostingFail('HOSTING_TRAINING_RECIPIENT_MISMATCH')
            const rows = await manager.getRepository(HostingTrainingEntity).find({ where: [
                { platformId: input.platformId }, { enrollmentId: input.enrollmentId }, { receiptId: input.receiptId },
            ] })
            if (rows.length) {
                const existing = rows[0]
                if (rows.length !== 1 || Object.entries(input).some(([key, value]) => existing[key as keyof Binding] !== value)) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return existing
            }
            // Do not erase liabilities or silently replace a subscription with a course grant.
            if (account.planId !== 'trial' || account.status === 'suspended' || account.billingHold || account.activeExecutions !== 0 ||
                await manager.getRepository(HostingStripeBindingEntity).existsBy({ platformId: account.id }) ||
                await manager.getRepository(HostingReservationEntity).existsBy({ platformId: account.id, state: In(['reserved', 'running', 'uncertain', 'paused']) }) ||
                await manager.getRepository(HostingModelCallEntity).existsBy({ platformId: account.id, state: In(['prepared', 'running', 'uncertain']) })) hostingFail('HOSTING_TRAINING_ACTIVATION_REQUIRES_REVIEW')
            const startsAt = await tx.now(manager)
            const periods = newPartnerTrainingPeriods(startsAt)
            const endsAt = periods[periods.length - 1].until
            const record = await manager.getRepository(HostingTrainingEntity).save({ id: apId(), ...input, operatorIdentityId: actor.identityId, startsAt, endsAt, revokedAt: null })
            const credits = await effectiveHostedCredits(manager, account.id, 'training')
            // All periods are created exactly once. Future allowances cannot be used early;
            // balance reads never grant credits and no renewal scheduler can duplicate them.
            for (let period = 0; period < periods.length; period++) {
                for (const [meter, amount] of [['execution', BigInt(credits)], ['managed_ai', 0n]] as const) {
                    const grantId = apId()
                    await manager.getRepository(HostingGrantEntity).insert({
                        id: grantId, platformId: account.id, sourceKey: `training:${record.id}:${period}`, meter, amount, reserved: 0n, consumed: 0n,
                        validFrom: periods[period].from, validUntil: periods[period].until,
                    })
                    await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId, reservationId: null, operation: 'grant', key: `grant:${grantId}`, amount })
                }
            }
            await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { planId: 'training', status: 'active', validUntil: endsAt, catalogVersion: hostingCatalog.version })
            await tx.event({ manager, platformId: account.id, event: 'training.activated', payload: { trainingId: record.id, enrollmentId: input.enrollmentId, tier: input.tier, operatorIdentityId: actor.identityId } })
            return record
        } })
    }

    async function revokeBinding({ actor, enrollmentId }: { actor: HostingActor, enrollmentId: string }, purchaseId?: string): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            if (purchaseId) await assertVerifiedReceipt(manager, purchaseId, { enrollmentId })
            else await assertHostingOperator({ manager, actor })
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId }, lock: { mode: 'pessimistic_write' } })
            if (!enrollment) hostingFail('HOSTING_TRAINING_NOT_FOUND')
            const peek = await manager.getRepository(HostingTrainingEntity).findOneBy({ enrollmentId })
            if (!peek) hostingFail('HOSTING_TRAINING_NOT_FOUND')
            const account = await tx.account({ manager, platformId: peek.platformId })
            const record = await manager.getRepository(HostingTrainingEntity).findOneByOrFail({ id: peek.id })
            await revokeAssessmentAccess({ manager, enrollmentId, actorIdentityId: actor.identityId })
            if (record.revokedAt) return
            const now = await tx.now(manager)
            await manager.getRepository(HostingTrainingEntity).update({ id: record.id }, { revokedAt: now })
            const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId: account.id })
            for (const grant of grants.filter(value => value.sourceKey.startsWith(`training:${record.id}:`) && !value.revokedAt)) {
                await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { revokedAt: now })
                const available = grant.amount - grant.reserved - grant.consumed
                await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId: grant.id, reservationId: null, operation: 'revoke', key: `revoke:${grant.id}`, amount: available > 0n ? available : 0n })
            }
            if (account.planId === 'training' && account.validUntil.getTime() === record.endsAt.getTime()) await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { validUntil: now })
            await tx.event({ manager, platformId: account.id, event: 'training.revoked', payload: { trainingId: record.id, enrollmentId, operatorIdentityId: actor.identityId } })
        } })
    }
    async function activate(input: Binding & { actor: HostingActor }) {
        return activateBinding(input)
    }
    async function revoke(input: { actor: HostingActor, enrollmentId: string }) {
        return revokeBinding(input)
    }
    // Internal receipt methods derive all recipient/package/receipt values from
    // persisted verified Stripe evidence; no customer request can call these.
    async function activateVerifiedPurchase(purchaseId: string) {
        const purchase = await (existingManager ?? dataSource.manager).getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id: purchaseId })
        if (!purchase.enrollmentId) hostingFail('HOSTING_PARTNER_RECEIPT_UNVERIFIED')
        return activateBinding({ actor: { identityId: purchase.identityId, platformId: purchase.platformId }, platformId: purchase.platformId, identityId: purchase.identityId, enrollmentId: purchase.enrollmentId, receiptId: `stripe-partner:${purchase.id}`, tier: purchase.package === 'guided' ? 'launch' : 'core' }, purchase.id)
    }
    async function revokeVerifiedPurchase(purchaseId: string) {
        const purchase = await (existingManager ?? dataSource.manager).getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id: purchaseId })
        if (!purchase.enrollmentId) hostingFail('HOSTING_PARTNER_RECEIPT_UNVERIFIED')
        return revokeBinding({ actor: { identityId: purchase.identityId, platformId: purchase.platformId }, enrollmentId: purchase.enrollmentId }, purchase.id)
    }
    return { activate, revoke, activateVerifiedPurchase, revokeVerifiedPurchase }
}

async function assertVerifiedReceipt(manager: EntityManager, purchaseId: string, binding: Partial<Binding>): Promise<void> {
    const purchase = await manager.getRepository(HostingPartnerPurchaseEntity).findOneBy({ id: purchaseId })
    if (!purchase || !purchase.sessionId || !purchase.customerId || !purchase.chargeId || !purchase.paymentIntentId || !purchase.enrollmentId || !['ready', 'fulfilled'].includes(purchase.state) || purchase.amountMinor !== (purchase.package === 'core' ? 100000 : 120000)) hostingFail('HOSTING_PARTNER_RECEIPT_UNVERIFIED')
    const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOneBy({ id: purchase.enrollmentId })
    if (!enrollment || enrollment.courseId !== purchase.courseId || enrollment.paymentReference !== `stripe-partner:${purchase.id}` || enrollment.workspacePlatformId !== purchase.platformId || enrollment.identityId !== purchase.identityId) hostingFail('HOSTING_PARTNER_RECEIPT_BINDING_MISMATCH')
    const expected = { platformId: purchase.platformId, identityId: purchase.identityId, enrollmentId: purchase.enrollmentId, receiptId: `stripe-partner:${purchase.id}`, tier: purchase.package === 'guided' ? 'launch' : 'core' }
    if (Object.entries(binding).some(([key, value]) => expected[key as keyof typeof expected] !== value)) hostingFail('HOSTING_PARTNER_RECEIPT_UNVERIFIED')
    if (binding.receiptId && purchase.refundedMinor >= purchase.amountMinor) hostingFail('HOSTING_PARTNER_RECEIPT_REFUNDED')
    if (!binding.receiptId && purchase.refundedMinor !== purchase.amountMinor) hostingFail('HOSTING_PARTNER_REFUND_UNVERIFIED')
}
