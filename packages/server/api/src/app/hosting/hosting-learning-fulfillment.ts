import { DataSource, EntityManager, IsNull } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { LmsCertificateEntity, LmsEnrollmentEntity } from '../lms/lms-entities'
import { assertHostingOperator } from './hosting-access-policy'
import { assertPartnerTrainingEnrollment, createHostedTraining } from './hosting-training'
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
    bindWorkspace(input: { actor: HostingActor, enrollmentId: string, workspacePlatformId: string, expectedWorkspacePlatformId: string | null }): Promise<{ enrollmentId: string, workspacePlatformId: string }>
    activate(input: { actor: HostingActor, enrollmentId: string }): Promise<LearningTrainingActivation>
    revoke(input: { actor: HostingActor, enrollmentId: string }): Promise<void>
}

const days = (from: Date, count: number): Date => new Date(from.getTime() + count * 86_400_000)

// Operator-assisted pilot fulfillment. Read the trusted enrollment from our own
// database; no caller-supplied recipient, package, receipt or credit amount is used.
export function createLearningFulfillment({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }): LearningFulfillment {
    async function bindWorkspace({ actor, enrollmentId, workspacePlatformId, expectedWorkspacePlatformId }: { actor: HostingActor, enrollmentId: string, workspacePlatformId: string, expectedWorkspacePlatformId: string | null }) {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            // Match activation/revocation lock order: enrollment, then account.
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId }, lock: { mode: 'pessimistic_write' } })
            const now = await tx.now(manager)
            if (!enrollment || enrollment.status !== 'active' || enrollment.startsAt > now || enrollment.accessUntil <= now || enrollment.assessmentUntil <= now) hostingFail('HOSTING_LEARNING_ENROLLMENT_UNAVAILABLE')
            await assertPartnerTrainingEnrollment(manager, enrollment)
            if (await manager.getRepository(HostingTrainingEntity).existsBy({ enrollmentId })) hostingFail('HOSTING_LEARNING_WORKSPACE_LOCKED')
            await assertLearningWorkspaceOwner(manager, enrollment.identityId, workspacePlatformId)
            await assertHostingOperator({ manager, actor })
            if (enrollment.workspacePlatformId === workspacePlatformId) return { enrollmentId, workspacePlatformId }
            if (enrollment.workspacePlatformId !== expectedWorkspacePlatformId) hostingFail('HOSTING_LEARNING_WORKSPACE_CHANGED')
            await manager.getRepository(LmsEnrollmentEntity).update({ id: enrollmentId }, { workspacePlatformId })
            await tx.event({ manager, platformId: actor.platformId, event: 'learning.workspace.bound', payload: { enrollmentId, previousWorkspacePlatformId: enrollment.workspacePlatformId, workspacePlatformId, operatorIdentityId: actor.identityId } })
            return { enrollmentId, workspacePlatformId }
        } })
    }
    async function activate({ actor, enrollmentId }: { actor: HostingActor, enrollmentId: string }): Promise<LearningTrainingActivation> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId }, lock: { mode: 'pessimistic_write' } })
            const now = await tx.now(manager)
            if (!enrollment || enrollment.status !== 'active' || enrollment.startsAt > now || enrollment.accessUntil <= now || enrollment.assessmentUntil <= now) hostingFail('HOSTING_LEARNING_ENROLLMENT_UNAVAILABLE')
            await assertPartnerTrainingEnrollment(manager, enrollment)
            if (!enrollment.workspacePlatformId || !enrollment.paymentReference?.trim() || !enrollment.package) hostingFail('HOSTING_LEARNING_FULFILLMENT_INCOMPLETE')
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

    return { activate, revoke, bindWorkspace }
}

export async function assertLearningWorkspaceOwner(manager: EntityManager, identityId: string, platformId: string): Promise<void> {
    const account = await tx.account({ manager, platformId })
    if (account.ownerIdentityId !== identityId || !await manager.getRepository(UserIdentityEntity).existsBy({ id: identityId, verified: true })) hostingFail('HOSTING_TRAINING_RECIPIENT_MISMATCH')
}
