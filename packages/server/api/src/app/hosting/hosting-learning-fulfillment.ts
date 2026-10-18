import { DataSource, EntityManager, IsNull } from 'typeorm'
import { LmsCertificateEntity, LmsEnrollmentEntity } from '../lms/lms-entities'
import { assertHostingOperator } from './hosting-access-policy'
import { createHostedTraining } from './hosting-training'
import { HostingTrainingEntity } from './hosting-training-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

type LearningTrainingActivation = {
    trainingId: string
    platformId: string
    enrollmentId: string
    package: 'core' | 'launch'
    startsAt: string
    endsAt: string
    revoked: boolean
}
type LearningFulfillment = {
    activate(input: { actor: HostingActor, enrollmentId: string }): Promise<LearningTrainingActivation>
    revoke(input: { actor: HostingActor, enrollmentId: string }): Promise<void>
}

const days = (from: Date, count: number): Date => new Date(from.getTime() + count * 86_400_000)

// Operator-assisted pilot fulfillment. Read the trusted enrollment from our own
// database; no caller-supplied recipient, package, receipt or credit amount is used.
export function createLearningFulfillment({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }): LearningFulfillment {
    async function activate({ actor, enrollmentId }: { actor: HostingActor, enrollmentId: string }): Promise<LearningTrainingActivation> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId }, lock: { mode: 'pessimistic_write' } })
            const now = await tx.now(manager)
            if (!enrollment || enrollment.status !== 'active' || enrollment.startsAt > now || enrollment.accessUntil <= now || enrollment.assessmentUntil <= now) hostingFail('HOSTING_LEARNING_ENROLLMENT_UNAVAILABLE')
            if (!enrollment.workspacePlatformId || !enrollment.paymentReference.trim()) hostingFail('HOSTING_LEARNING_FULFILLMENT_INCOMPLETE')
            const training = await createHostedTraining({ dataSource, manager }).activate({
                actor,
                platformId: enrollment.workspacePlatformId,
                identityId: enrollment.identityId,
                enrollmentId: enrollment.id,
                receiptId: enrollment.paymentReference,
                tier: enrollment.package,
            })
            if (training.revokedAt) hostingFail('HOSTING_LEARNING_TRAINING_REVOKED')
            // Starting access clocks at working workspace delivery is idempotent:
            // a repeated activation reuses the original training start, never now.
            await manager.getRepository(LmsEnrollmentEntity).update({ id: enrollment.id }, {
                startsAt: training.startsAt,
                accessUntil: days(training.startsAt, 365),
                assessmentUntil: days(training.startsAt, 90),
            })
            return {
                trainingId: training.id,
                platformId: training.platformId,
                enrollmentId: training.enrollmentId,
                package: training.tier,
                startsAt: training.startsAt.toISOString(),
                endsAt: training.endsAt.toISOString(),
                revoked: false,
            }
        } })
    }

    async function revoke({ actor, enrollmentId }: { actor: HostingActor, enrollmentId: string }): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId }, lock: { mode: 'pessimistic_write' } })
            if (!enrollment) hostingFail('HOSTING_LEARNING_ENROLLMENT_NOT_FOUND')
            if (await manager.getRepository(HostingTrainingEntity).existsBy({ enrollmentId })) {
                await createHostedTraining({ dataSource, manager }).revoke({ actor, enrollmentId })
            }
            const now = await tx.now(manager)
            await manager.getRepository(LmsEnrollmentEntity).update({ id: enrollmentId }, { status: 'revoked' })
            await manager.getRepository(LmsCertificateEntity).update({ enrollmentId, revokedAt: IsNull() }, { revokedAt: now })
            await tx.event({ manager, platformId: actor.platformId, event: 'learning.enrollment.revoked', payload: { enrollmentId, operatorIdentityId: actor.identityId } })
        } })
    }

    return { activate, revoke }
}
