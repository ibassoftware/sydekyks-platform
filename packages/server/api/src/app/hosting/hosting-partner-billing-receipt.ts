import { apId } from '@activepieces/core-utils'
import { DataSource, EntityManager, IsNull } from 'typeorm'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../lms/lms-entities'
import { hostingResourceUsage } from './hosting-billing-resources'
import { assertLearningWorkspaceOwner, revokeVerifiedLearningReceipt } from './hosting-learning-fulfillment'
import { HostingPartnerPurchaseEntity, PartnerPurchase } from './hosting-partner-billing-entities'
import { createHostedTraining } from './hosting-training'
import { HostingTrainingEntity } from './hosting-training-entity'
import { hostingMonthAnniversary } from './hosting-training-periods'
import { hostingFail, hostingTransactions as tx } from './hosting-transactions'

type Input = { dataSource: DataSource, manager: EntityManager, purchase: PartnerPurchase }
// Called only inside the Stripe verifier's atomic receipt transaction. The
// payment reference remains an immutable provenance link for manual tooling.
export async function fulfillPartnerPurchaseReceipt({ dataSource, manager, purchase }: Input) {
    const stored = await manager.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id: purchase.id })
    if (!stored.chargeId || !stored.paymentIntentId || !stored.customerId || !stored.sessionId || !['ready', 'fulfilled'].includes(stored.state) || stored.refundedMinor >= stored.amountMinor) hostingFail('HOSTING_PARTNER_RECEIPT_UNVERIFIED')
    const receiptId = `stripe-partner:${stored.id}`
    const existingTraining = stored.trainingId ? await manager.getRepository(HostingTrainingEntity).findOneBy({ id: stored.trainingId, enrollmentId: stored.enrollmentId ?? '', receiptId, platformId: stored.platformId, identityId: stored.identityId }) : null
    if (stored.trainingId && (!existingTraining || existingTraining.revokedAt)) hostingFail('HOSTING_PARTNER_RECEIPT_BINDING_MISMATCH')
    let enrollment = stored.enrollmentId ? await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: stored.enrollmentId }, lock: { mode: 'pessimistic_write' } }) : null
    if (!enrollment) {
        const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: stored.courseId, status: 'published', ownerPlatformId: IsNull(), audience: 'partner', certificationMode: 'partner' })
        if (!course) hostingFail('HOSTING_PARTNER_COURSE_UNAVAILABLE')
        await assertLearningWorkspaceOwner(manager, stored.identityId, stored.platformId)
        if (await manager.getRepository(LmsEnrollmentEntity).existsBy({ identityId: stored.identityId, courseId: stored.courseId, grantPlatformId: IsNull() }) || await manager.getRepository(HostingTrainingEntity).existsBy({ platformId: stored.platformId })) hostingFail('HOSTING_PARTNER_PURCHASE_REQUIRES_REVIEW')
        const now = await tx.now(manager)
        const usage = await hostingResourceUsage(manager, stored.platformId, now)
        if (usage.users + usage.pendingUsers > 1 || usage.projects + usage.pendingProjects > 1) hostingFail('HOSTING_PARTNER_OWN_WORKSPACE_REQUIRED')
        enrollment = await manager.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId: stored.identityId, courseId: stored.courseId, grantPlatformId: null, accessType: 'partner_training', package: stored.package === 'guided' ? 'launch' : 'core', paymentReference: receiptId, workspacePlatformId: stored.platformId, startsAt: now, accessUntil: hostingMonthAnniversary(now, 12), assessmentUntil: new Date(now.getTime() + 90 * 86400_000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: stored.identityId })
        await manager.getRepository(HostingPartnerPurchaseEntity).update({ id: stored.id }, { enrollmentId: enrollment.id })
    }
    if (enrollment.status !== 'active' || enrollment.identityId !== stored.identityId || enrollment.courseId !== stored.courseId || enrollment.workspacePlatformId !== stored.platformId || enrollment.paymentReference !== receiptId || enrollment.package !== (stored.package === 'guided' ? 'launch' : 'core')) hostingFail('HOSTING_PARTNER_RECEIPT_BINDING_MISMATCH')
    if (existingTraining) return { enrollmentId: enrollment.id, trainingId: existingTraining.id }
    const training = await createHostedTraining({ dataSource, manager }).activateVerifiedPurchase(stored.id)
    if (training.revokedAt || (stored.trainingId && training.id !== stored.trainingId)) hostingFail('HOSTING_PARTNER_RECEIPT_BINDING_MISMATCH')
    await manager.getRepository(LmsEnrollmentEntity).update({ id: enrollment.id }, { startsAt: training.startsAt, accessUntil: training.endsAt, assessmentUntil: new Date(training.startsAt.getTime() + 90 * 86400_000) })
    return { enrollmentId: enrollment.id, trainingId: training.id }
}
export async function revokePartnerPurchaseReceipt({ dataSource, manager, purchase }: Input): Promise<void> {
    if (!purchase.enrollmentId || !purchase.trainingId) hostingFail('HOSTING_PARTNER_RECEIPT_BINDING_MISMATCH')
    const training = await manager.getRepository(HostingTrainingEntity).findOneBy({ id: purchase.trainingId, enrollmentId: purchase.enrollmentId, receiptId: `stripe-partner:${purchase.id}`, platformId: purchase.platformId, identityId: purchase.identityId })
    if (!training) hostingFail('HOSTING_PARTNER_RECEIPT_BINDING_MISMATCH')
    await revokeVerifiedLearningReceipt({ dataSource, manager, purchaseId: purchase.id })
}
