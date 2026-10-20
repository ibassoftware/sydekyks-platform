import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { HostingTrainingEntity } from '../../src/app/hosting/hosting-training-entity'
import { HostingActor, hostingTransactions } from '../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../src/app/lms/lms-content'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../../src/app/lms/lms-entities'
import { bootstrapHostedOperator } from './hosting-fixtures'

export async function subscriptionIdentity(ds: DataSource) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, verified: true, provider: 'EMAIL', password: 'synthetic-unused', firstName: 'Subscription', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
export async function subscriptionOperator(ds: DataSource) {
    const id = await subscriptionIdentity(ds)
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-subscription-fixture-secret-atleast32characters' })
    const home = await bootstrapHostedOperator(ds, onboarding, id)
    return { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion } satisfies HostingActor
}
export async function fundedCore(ds: DataSource, operator: HostingActor) {
    const identityId = await subscriptionIdentity(ds)
    const tenant = await createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-subscription-fixture-secret-atleast32characters' }).provision({ identityId, name: 'Funded Core fixture', operator })
    const actor = { identityId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion }
    const courseId = apId(), enrollmentId = apId(), receiptId = `synthetic-not-real-payment:${apId()}`, now = await hostingTransactions.now(ds.manager)
    await ds.getRepository(LmsCourseEntity).insert({ id: courseId, slug: `synthetic-${courseId}`, ownerPlatformId: null, audience: 'partner', certificationMode: 'partner', revision: 1, status: 'published', content: foundingCourseDraft, reviewedBy: operator.identityId, reviewedAt: now })
    await ds.getRepository(LmsEnrollmentEntity).insert({ id: enrollmentId, courseId, identityId, grantPlatformId: null, accessType: 'partner_training', package: 'core', paymentReference: receiptId, workspacePlatformId: tenant.platformId, startsAt: now, accessUntil: new Date(now.getTime() + 365 * 86400000), assessmentUntil: new Date(now.getTime() + 90 * 86400000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: operator.identityId })
    // Explicit historical fixture: these renewal tests must continue exercising
    // pre-upgrade Core receipts, not silently adopt the new twelve-month offer.
    const startsAt = now, endsAt = new Date(now.getTime() + 60 * 86400000)
    const training = await ds.getRepository(HostingTrainingEntity).save({ id: apId(), platformId: tenant.platformId, identityId, enrollmentId, receiptId, tier: 'core', operatorIdentityId: operator.identityId, startsAt, endsAt, revokedAt: null })
    for (let period = 0; period < 2; period++) {
        for (const [meter, amount] of [['execution', 1000n], ['managed_ai', 5000000n]] as const) {
            const id = apId()
            await ds.getRepository(HostingGrantEntity).insert({ id, platformId: tenant.platformId, sourceKey: `training:${training.id}:${period}`, meter, amount, consumed: 0n, reserved: 0n, validFrom: new Date(now.getTime() + period * 30 * 86400000), validUntil: new Date(now.getTime() + (period + 1) * 30 * 86400000) })
            await ds.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: tenant.platformId, grantId: id, reservationId: null, operation: 'grant', key: `grant:${id}`, amount })
        }
    }
    await ds.getRepository(HostingAccountEntity).update({ id: tenant.platformId }, { planId: 'training', status: 'active', catalogVersion: '2026-10-15.v1', validUntil: endsAt })
    return { ...tenant, identityId, actor, trainingId: training.id, enrollmentId }
}
// Disposable time-position fixture only: funding/grant amounts and all LMS,
// assessment, certificate and receipt fields are preserved. Never production API.
export async function positionCoreAfterEnd(ds: DataSource, platformId: string) {
    const delta = 61 * 86_400_000, shift = (value: Date) => new Date(value.getTime() - delta)
    const account = await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: platformId })
    const training = await ds.getRepository(HostingTrainingEntity).findOneByOrFail({ platformId })
    await ds.getRepository(HostingAccountEntity).update({ id: platformId }, { validUntil: shift(account.validUntil) })
    await ds.getRepository(HostingTrainingEntity).update({ id: training.id }, { startsAt: shift(training.startsAt), endsAt: shift(training.endsAt) })
    for (const grant of await ds.getRepository(HostingGrantEntity).findBy({ platformId })) await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { validFrom: shift(grant.validFrom), validUntil: shift(grant.validUntil) })
}
