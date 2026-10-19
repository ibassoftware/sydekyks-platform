import { apId } from '@activepieces/core-utils'
import { HOSTED_MICRO_USD_PER_CREDIT, hostingCatalog, UserStatus } from '@activepieces/shared'
import { DataSource, EntityManager, In } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../lms/lms-entities'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator, isOperationalUser } from './hosting-access-policy'
import { HostingAssessment, HostingAssessmentEntity } from './hosting-assessment-entity'
import { hostingResourceUsage } from './hosting-billing-resources'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity, HostingReservationEntity } from './hosting-entities'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { HostingStripeBindingEntity } from './hosting-stripe-entities'
import { HostingTrainingEntity } from './hosting-training-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export function createHostedAssessment({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }) {
    async function activate({ actor, enrollmentId }: { actor: HostingActor, enrollmentId: string }): Promise<HostingAssessment> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            // All learning activation/revocation uses enrollment -> account locks.
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId }, lock: { mode: 'pessimistic_write' } })
            let now = await tx.now(manager)
            if (!enrollment || enrollment.status !== 'active' || enrollment.accessType !== 'partner_training' || enrollment.package !== 'core' || enrollment.grantPlatformId !== null || !enrollment.paymentReference || !enrollment.workspacePlatformId || enrollment.startsAt > now || enrollment.assessmentUntil <= now || enrollment.accessUntil <= now) hostingFail('HOSTING_ASSESSMENT_NOT_ELIGIBLE')
            const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: enrollment.courseId, status: 'published' })
            if (!course || course.ownerPlatformId !== null || course.audience !== 'partner' || course.certificationMode !== 'partner') hostingFail('HOSTING_ASSESSMENT_NOT_ELIGIBLE')
            const account = await tx.account({ manager, platformId: enrollment.workspacePlatformId })
            now = await tx.now(manager)
            if (account.subscription?.policy?.renewalDueAt) hostingFail('HOSTING_ASSESSMENT_RENEWAL_OVERRIDE_REQUIRES_REVIEW')
            if (enrollment.assessmentUntil <= now || enrollment.accessUntil <= now) hostingFail('HOSTING_ASSESSMENT_NOT_ELIGIBLE')
            const training = await manager.getRepository(HostingTrainingEntity).findOneBy({ enrollmentId })
            if (!training || training.revokedAt || training.tier !== 'core' || training.platformId !== account.id || training.identityId !== enrollment.identityId || training.receiptId !== enrollment.paymentReference || account.ownerIdentityId !== enrollment.identityId || training.endsAt > now || enrollment.assessmentUntil.getTime() > training.startsAt.getTime() + 90 * 86_400_000) hostingFail('HOSTING_ASSESSMENT_NOT_ELIGIBLE')
            const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: enrollment.identityId, verified: true })
            const member = await manager.getRepository(UserEntity).findOneBy({ identityId: enrollment.identityId, platformId: account.id, status: UserStatus.ACTIVE })
            if (!identity || !member || isOperationalUser(member)) hostingFail('HOSTING_ASSESSMENT_RECIPIENT_MISMATCH')
            const existing = await manager.getRepository(HostingAssessmentEntity).findOneBy({ enrollmentId })
            if (existing) {
                if (existing.platformId !== account.id || existing.identityId !== enrollment.identityId || existing.trainingId !== training.id || existing.endsAt.getTime() !== enrollment.assessmentUntil.getTime()) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                if (existing.revokedAt || existing.endsAt <= now || account.planId !== 'assessment') hostingFail('HOSTING_ASSESSMENT_CLOSED')
                return existing
            }
            // Assessment is not a subscription replacement or a release of held costs.
            if (account.planId !== 'training' || account.validUntil > now || account.validUntil.getTime() !== training.endsAt.getTime() || account.status === 'suspended' || account.billingHold || account.activeExecutions !== 0 ||
                await manager.getRepository(HostingStripeBindingEntity).existsBy({ platformId: account.id }) ||
                await manager.getRepository(HostingReservationEntity).existsBy({ platformId: account.id, state: In(['reserved', 'running', 'uncertain', 'paused']) }) ||
                await manager.getRepository(HostingModelCallEntity).existsBy({ platformId: account.id, state: In(['prepared', 'running', 'uncertain']) })) hostingFail('HOSTING_ASSESSMENT_REQUIRES_REVIEW')
            const usage = await hostingResourceUsage(manager, account.id, now)
            if (usage.users + usage.pendingUsers > 1 || usage.projects + usage.pendingProjects > 1) hostingFail('HOSTING_ASSESSMENT_REQUIRES_REVIEW')
            await assertHostingOperator({ manager, actor })
            const record = await manager.getRepository(HostingAssessmentEntity).save({ id: apId(), enrollmentId, trainingId: training.id, platformId: account.id, identityId: enrollment.identityId, operatorIdentityId: actor.identityId, startsAt: now, endsAt: enrollment.assessmentUntil, revokedAt: null })
            const limits = hostingCatalog.getPlan({ planId: 'assessment' })
            for (const [meter, amount] of [['execution', BigInt(limits.executions)], ['managed_ai', BigInt(limits.aiCredits) * HOSTED_MICRO_USD_PER_CREDIT]] as const) {
                const grantId = apId()
                await manager.getRepository(HostingGrantEntity).insert({ id: grantId, platformId: account.id, sourceKey: `assessment:${record.id}`, meter, amount, reserved: 0n, consumed: 0n, validFrom: record.startsAt, validUntil: record.endsAt })
                await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId, reservationId: null, operation: 'grant', key: `grant:${grantId}`, amount })
            }
            await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { planId: 'assessment', status: 'active', validUntil: record.endsAt })
            await tx.event({ manager, platformId: account.id, event: 'assessment.activated', payload: { assessmentId: record.id, enrollmentId, trainingId: training.id, operatorIdentityId: actor.identityId } })
            return record
        } })
    }
    async function revoke({ actor, enrollmentId }: { actor: HostingActor, enrollmentId: string }): Promise<void> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId }, lock: { mode: 'pessimistic_write' } })
            if (!enrollment) hostingFail('HOSTING_ASSESSMENT_NOT_FOUND')
            await revokeAssessmentAccess({ manager, enrollmentId, actorIdentityId: actor.identityId })
        } })
    }
    return { activate, revoke }
}

// Used inside the same transaction by training/enrollment revocation. Liabilities
// stay attached to their original grant and may settle; revocation never erases them.
export async function revokeAssessmentAccess({ manager, enrollmentId, actorIdentityId }: { manager: EntityManager, enrollmentId: string, actorIdentityId: string }): Promise<void> {
    const record = await manager.getRepository(HostingAssessmentEntity).findOneBy({ enrollmentId })
    if (!record || record.revokedAt) return
    const account = await tx.account({ manager, platformId: record.platformId }), now = await tx.now(manager)
    await manager.getRepository(HostingAssessmentEntity).update({ id: record.id }, { revokedAt: now })
    const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId: account.id, sourceKey: `assessment:${record.id}` })
    for (const grant of grants.filter(row => !row.revokedAt)) {
        await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { revokedAt: now })
        const remaining = grant.amount - grant.reserved - grant.consumed
        await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId: grant.id, reservationId: null, operation: 'revoke', key: `revoke:${grant.id}`, amount: remaining > 0n ? remaining : 0n })
    }
    if (account.planId === 'assessment') await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { validUntil: now })
    await tx.event({ manager, platformId: account.id, event: 'assessment.revoked', payload: { assessmentId: record.id, enrollmentId, operatorIdentityId: actorIdentityId } })
}
