import { apId } from '@activepieces/core-utils'
import { PlatformRole, PrincipalType, UserStatus } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessTokenManager } from '../../src/app/authentication/lib/access-token-manager'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { authenticationMiddleware } from '../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { errorHandler } from '../../src/app/helper/error-handler'
import { createHostedAccess } from '../../src/app/hosting/hosting-access'
import { hostingAccessController } from '../../src/app/hosting/hosting-access-controller'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { HostingAccountEntity, HostingEligibilityEntity, HostingGrantEntity, HostingLedgerEntity, HostingOutboxEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createLearningFulfillment } from '../../src/app/hosting/hosting-learning-fulfillment'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { hostingServices } from '../../src/app/hosting/hosting-services'
import { createHostedTraining } from '../../src/app/hosting/hosting-training'
import { HostingTrainingEntity } from '../../src/app/hosting/hosting-training-entity'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../src/app/lms/lms-content'
import { lmsController } from '../../src/app/lms/lms-controller'
import { LmsCourseEntity, LmsEnrollment, LmsEnrollmentEntity } from '../../src/app/lms/lms-entities'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, app: FastifyInstance, previousConnection: unknown, actor: HostingActor, operatorUserId: string
let learner: Awaited<ReturnType<typeof workspace>>, other: Awaited<ReturnType<typeof workspace>>, enrollment: LmsEnrollment, courseId: string
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-learning-workspace-subject-at-least32characters' })
const fulfillment = () => createLearningFulfillment({ dataSource: ds })
const readEnrollment = () => ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: enrollment.id })
const grants = () => ds.getRepository(HostingGrantEntity).find({ order: { id: 'ASC' } })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', verified: true, password: 'unused', firstName: 'Learning', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
async function workspace(name: string) {
    const identityId = await identity(), tenant = await onboarding().provision({ identityId, name, operator: actor })
    return { ...tenant, identityId, actor: { identityId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion } }
}
async function headers(userId = operatorUserId, value = actor) {
    const token = await accessTokenManager(app.log).generateToken({ id: userId, platform: { id: value.platformId }, type: PrincipalType.USER, tokenVersion: value.tokenVersion })
    return { authorization: `Bearer ${token}` }
}
const bind = (expectedWorkspacePlatformId: string | null = null) => fulfillment().bindWorkspace({ actor, enrollmentId: enrollment.id, workspacePlatformId: learner.platformId, expectedWorkspacePlatformId })
beforeAll(async () => {
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    app = fastify()
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); app.setErrorHandler(errorHandler)
    app.addHook('preHandler', authenticationMiddleware); app.addHook('preHandler', authorizationMiddleware)
    // Bind the production service factory to the isolated fixture's subject secret.
    // Operator authentication and the complete onboarding transaction remain real.
    vi.spyOn(hostingServices, 'onboarding').mockImplementation(async () => onboarding())
    await app.register(lmsController, { prefix: '/api/v1/lms' })
    await app.register(hostingAccessController, { prefix: '/api/v1/hosting/operator' }); await app.ready()
})
afterAll(async () => {
    if (app) await app.close()
    vi.restoreAllMocks()
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const operatorId = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), operatorId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', operatorId)
    actor = { identityId: operatorId, platformId: home.platformId, tokenVersion: home.tokenVersion }; operatorUserId = home.userId
    learner = await workspace('Synthetic learner workspace'); other = await workspace('Synthetic other workspace')
    courseId = apId()
    await ds.getRepository(LmsCourseEntity).insert({ id: courseId, slug: 'synthetic-workspace-course', revision: 1, status: 'published', content: foundingCourseDraft, reviewedBy: actor.identityId, reviewedAt: new Date() })
    const now = Date.now()
    enrollment = await ds.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId: learner.identityId, courseId, package: 'core', paymentReference: `synthetic-receipt-${apId()}`, workspacePlatformId: null, startsAt: new Date(now - 1000), accessUntil: new Date(now + 365 * 86400000), assessmentUntil: new Date(now + 90 * 86400000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
})

describe('operator learning workspace repair', () => {
    it.each([null, 'wrong-owner'] as const)('repairs %s linkage without changing receipt, package, clocks or credits and replays without another audit event', async previous => {
        const previousWorkspace = previous === null ? null : other.platformId
        await ds.getRepository(LmsEnrollmentEntity).update({ id: enrollment.id }, { workspacePlatformId: previousWorkspace })
        const before = await readEnrollment(), credits = await grants(), ledgerCount = await ds.getRepository(HostingLedgerEntity).count()
        await bind(previousWorkspace)
        const after = await readEnrollment()
        expect(after).toMatchObject({ workspacePlatformId: learner.platformId, identityId: before.identityId, courseId: before.courseId, paymentReference: before.paymentReference, package: before.package, startsAt: before.startsAt, accessUntil: before.accessUntil, assessmentUntil: before.assessmentUntil, completedLessons: before.completedLessons })
        expect(await grants()).toEqual(credits)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(ledgerCount)
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
        const audit = await ds.getRepository(HostingOutboxEntity).findBy({ event: 'learning.workspace.bound' })
        expect(audit).toHaveLength(1)
        expect(audit[0].payload).toMatchObject({ enrollmentId: enrollment.id, previousWorkspacePlatformId: previousWorkspace, workspacePlatformId: learner.platformId, operatorIdentityId: actor.identityId })
        await bind(apId()) // Same-target replay is valid even after the caller's old view is stale.
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'learning.workspace.bound' })).toBe(1)
        expect(await grants()).toEqual(credits)
    })
    it('refuses stale compare-and-set without partially repairing or writing audit history', async () => {
        await ds.getRepository(LmsEnrollmentEntity).update({ id: enrollment.id }, { workspacePlatformId: other.platformId })
        await expect(bind(null)).rejects.toThrow('WORKSPACE_CHANGED')
        expect((await readEnrollment()).workspacePlatformId).toBe(other.platformId)
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'learning.workspace.bound' })).toBe(0)
    })
    it('requires a current trusted operator and a verified learner-owned target', async () => {
        await expect(fulfillment().bindWorkspace({ actor: learner.actor, enrollmentId: enrollment.id, workspacePlatformId: learner.platformId, expectedWorkspacePlatformId: null })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(fulfillment().bindWorkspace({ actor: { ...actor, tokenVersion: 'stale' }, enrollmentId: enrollment.id, workspacePlatformId: learner.platformId, expectedWorkspacePlatformId: null })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(fulfillment().bindWorkspace({ actor, enrollmentId: enrollment.id, workspacePlatformId: other.platformId, expectedWorkspacePlatformId: null })).rejects.toThrow('RECIPIENT_MISMATCH')
        await expect(fulfillment().bindWorkspace({ actor, enrollmentId: enrollment.id, workspacePlatformId: apId(), expectedWorkspacePlatformId: null })).rejects.toThrow('ACCOUNT_NOT_FOUND')
        await ds.getRepository(UserIdentityEntity).update({ id: learner.identityId }, { verified: false })
        await expect(bind()).rejects.toThrow('RECIPIENT_MISMATCH')
        expect((await readEnrollment()).workspacePlatformId).toBeNull()
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
    })
    it.each([{ status: 'revoked' as const }, { accessUntil: new Date(0) }, { assessmentUntil: new Date(0) }, { startsAt: new Date('2099-01-01T00:00:00Z') }])('refuses unavailable enrollment %j', async change => {
        await ds.getRepository(LmsEnrollmentEntity).update({ id: enrollment.id }, change)
        await expect(bind()).rejects.toThrow('ENROLLMENT_UNAVAILABLE')
        expect((await readEnrollment()).workspacePlatformId).toBeNull()
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'learning.workspace.bound' })).toBe(0)
    })
    it.each([false, true])('locks workspace after any training activation, including revoked=%s', async revoked => {
        await bind()
        const activation = await fulfillment().activate({ actor, enrollmentId: enrollment.id })
        if (revoked) await createHostedTraining({ dataSource: ds }).revoke({ actor, enrollmentId: enrollment.id })
        const before = await readEnrollment(), credits = await grants()
        await expect(bind(learner.platformId)).rejects.toThrow('WORKSPACE_LOCKED')
        expect(await readEnrollment()).toEqual(before)
        expect(await grants()).toEqual(credits)
        expect(await ds.getRepository(HostingTrainingEntity).countBy({ id: activation.trainingId })).toBe(1)
    })
    it('activates repaired Core enrollment exactly once with two real fixed periods and preserves usage on replay', async () => {
        const clocksBefore = await readEnrollment()
        await bind()
        expect((await readEnrollment()).startsAt).toEqual(clocksBefore.startsAt)
        const activation = await fulfillment().activate({ actor, enrollmentId: enrollment.id })
        const record = await ds.getRepository(HostingTrainingEntity).findOneByOrFail({ id: activation.trainingId })
        expect(record).toMatchObject({ platformId: learner.platformId, identityId: learner.identityId, enrollmentId: enrollment.id, receiptId: enrollment.paymentReference, tier: 'core' })
        expect(record.endsAt.getTime() - record.startsAt.getTime()).toBe(60 * 86400000)
        const issued = (await grants()).filter(grant => grant.sourceKey.startsWith(`training:${record.id}:`))
        expect(issued).toHaveLength(4)
        expect(issued.filter(grant => grant.meter === 'managed_ai').map(grant => grant.amount)).toEqual([5000000n, 5000000n])
        expect(issued.filter(grant => grant.meter === 'execution').map(grant => grant.amount)).toEqual([1000n, 1000n])
        expect(issued.every(grant => grant.validUntil.getTime() - grant.validFrom.getTime() === 30 * 86400000)).toBe(true)
        const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor: learner.actor, projectId: learner.projectId!, key: 'learning-replay', payer: 'managed' }), rootClaim = await ledger.claimExecution({ actor: learner.actor, reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: learner.actor, rootReservationId: root.id, key: 'learning-replay-call', maxCostMicroUsd: 100n }), claim = await ledger.claimManagedCall({ actor: learner.actor, reservationId: call.id })
        await ledger.settleManagedCall({ platformId: learner.platformId, reservationId: call.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 50n })
        await ledger.finishExecution({ platformId: learner.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
        const beforeReplay = await grants(), enrollmentBeforeReplay = await readEnrollment()
        expect(await fulfillment().activate({ actor, enrollmentId: enrollment.id })).toEqual(activation)
        expect(await grants()).toEqual(beforeReplay)
        expect((await readEnrollment()).accessUntil).toEqual(enrollmentBeforeReplay.accessUntil)
        expect((await readEnrollment()).assessmentUntil).toEqual(enrollmentBeforeReplay.assessmentUntil)
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'training.activated' })).toBe(1)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: learner.platformId })).validUntil).toEqual(record.endsAt)
    })
    it('requires an owned workspace on new hosted HTTP enrollments and returns useful operator metadata', async () => {
        await ds.getRepository(LmsEnrollmentEntity).delete({ id: enrollment.id })
        const body = { identityId: learner.identityId, courseId, package: 'core', paymentReference: `synthetic-http-receipt-${apId()}`, paymentVerified: true }
        const auth = await headers()
        const missing = await app.inject({ method: 'POST', url: '/api/v1/lms/operator/enroll', headers: auth, payload: body })
        expect(missing.statusCode, missing.body).toBe(403)
        expect(missing.json().code).toBe('LMS_WORKSPACE_REQUIRED')
        const wrong = await app.inject({ method: 'POST', url: '/api/v1/lms/operator/enroll', headers: auth, payload: { ...body, workspacePlatformId: other.platformId } })
        expect(wrong.statusCode, wrong.body).toBe(403)
        const created = await app.inject({ method: 'POST', url: '/api/v1/lms/operator/enroll', headers: auth, payload: { ...body, workspacePlatformId: learner.platformId } })
        expect(created.statusCode, created.body).toBe(200)
        const rows = await app.inject({ url: '/api/v1/lms/operator/enrollments', headers: auth })
        expect(rows.statusCode, rows.body).toBe(200)
        expect(rows.json()).toHaveLength(1)
        expect(rows.json()[0]).toMatchObject({ identityId: learner.identityId, workspacePlatformId: learner.platformId, learnerEmail: `${learner.identityId}@test.invalid`, workspaceName: 'Synthetic learner workspace', training: null })
        await fulfillment().activate({ actor, enrollmentId: created.json().id })
        const active = await app.inject({ url: '/api/v1/lms/operator/enrollments', headers: auth })
        expect(active.json()[0].training).toMatchObject({ activated: true, revoked: false })
    })
    it('authenticates workspace repair HTTP calls and returns409 on stale linkage', async () => {
        await ds.getRepository(LmsEnrollmentEntity).update({ id: enrollment.id }, { workspacePlatformId: other.platformId })
        const request = { method: 'POST' as const, url: `/api/v1/lms/operator/enrollments/${enrollment.id}/workspace`, payload: { workspacePlatformId: learner.platformId, expectedWorkspacePlatformId: null } }
        expect((await app.inject(request)).statusCode).toBeGreaterThanOrEqual(400)
        expect((await app.inject({ ...request, headers: await headers(learner.userId, learner.actor) })).statusCode).toBe(403)
        const stale = await app.inject({ ...request, headers: await headers() })
        expect(stale.statusCode, stale.body).toBe(409)
        expect(stale.json().code).toBe('HOSTING_LEARNING_WORKSPACE_CHANGED')
        const repaired = await app.inject({ ...request, headers: await headers(), payload: { ...request.payload, expectedWorkspacePlatformId: other.platformId } })
        expect(repaired.statusCode, repaired.body).toBe(200)
        expect(repaired.json().workspacePlatformId).toBe(learner.platformId)
    })
})


describe('operator learner-owned home provisioning', () => {
    const url = '/api/v1/hosting/operator/tenants/owned-home'
    it('creates one owned trial home for an existing ordinary member while preserving their original membership and partner role', async () => {
        const identityId = await identity(), userId = apId()
        await ds.getRepository(UserEntity).insert({ id: userId, identityId, platformId: other.platformId, platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE })
        await createHostedAccess({ dataSource: ds }).setRole({ actor, identityId, role: 'partner', active: true })
        const previousMembership = await ds.getRepository(UserEntity).findOneByOrFail({ id: userId })
        const previousRole = await ds.getRepository(HostingAccessRoleEntity).findOneByOrFail({ id: identityId })
        const previousGrants = await grants(), accountCount = await ds.getRepository(HostingAccountEntity).count()
        expect(await ds.getRepository(HostingEligibilityEntity).countBy({ identityId })).toBe(0)
        const generic = await onboarding().provision({ identityId, name: 'Generic sign-in', operator: actor })
        expect(generic).toMatchObject({ platformId: other.platformId, userId, created: false })
        expect(await grants()).toEqual(previousGrants)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(accountCount)
        await expect(onboarding().provision({ identityId, name: 'Unauthorized owned home', requireOwnedHome: true })).rejects.toThrow('OPERATOR_PROVISIONING_REQUIRED')
        expect(await ds.getRepository(HostingEligibilityEntity).countBy({ identityId })).toBe(0)
        expect(await grants()).toEqual(previousGrants)

        const request = { method: 'POST' as const, url, headers: await headers(), payload: { identityId, name: 'Learner owned training home' } }
        const response = await app.inject(request)
        expect(response.statusCode, response.body).toBe(200)
        const created = response.json()
        expect(created.created).toBe(true)
        expect(created.platformId).not.toBe(other.platformId)
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: created.platformId })).toMatchObject({ ownerIdentityId: identityId, status: 'trialing', planId: 'trial' })
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ id: created.userId })).toMatchObject({ identityId, platformId: created.platformId, platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE })
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ id: userId })).toEqual(previousMembership)
        expect(await ds.getRepository(HostingAccessRoleEntity).findOneByOrFail({ id: identityId })).toEqual(previousRole)
        expect(await ds.getRepository(HostingEligibilityEntity).countBy({ identityId })).toBe(1)
        const ownGrants = await ds.getRepository(HostingGrantEntity).findBy({ platformId: created.platformId })
        expect(ownGrants).toHaveLength(2)
        expect(ownGrants.find(grant => grant.meter === 'execution')?.amount).toBe(1000n)
        expect(ownGrants.find(grant => grant.meter === 'managed_ai')?.amount).toBe(1000000n)
        expect(ownGrants.every(grant => grant.validUntil.getTime() - grant.validFrom.getTime() === 14 * 86400000)).toBe(true)
        const allGrants = await grants(), historyCount = await ds.getRepository(HostingLedgerEntity).count()
        const replay = await app.inject(request)
        expect(replay.statusCode, replay.body).toBe(200)
        expect(replay.json()).toMatchObject({ platformId: created.platformId, userId: created.userId, projectId: created.projectId, created: false })
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(accountCount + 1)
        expect(await grants()).toEqual(allGrants)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(historyCount)
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ id: userId })).toEqual(previousMembership)
        expect(await ds.getRepository(HostingAccessRoleEntity).findOneByOrFail({ id: identityId })).toEqual(previousRole)
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
    })
    it.each(['nonoperator', 'stale-operator', 'unverified-operator', 'unverified-learner'] as const)('denies %s without granting or creating an account', async denied => {
        const identityId = await identity(), before = await grants(), accountCount = await ds.getRepository(HostingAccountEntity).count()
        let auth = await headers()
        if (denied === 'nonoperator') auth = await headers(learner.userId, learner.actor)
        if (denied === 'stale-operator') auth = await headers(operatorUserId, { ...actor, tokenVersion: 'stale' })
        if (denied === 'unverified-operator') await ds.getRepository(UserIdentityEntity).update({ id: actor.identityId }, { verified: false })
        if (denied === 'unverified-learner') await ds.getRepository(UserIdentityEntity).update({ id: identityId }, { verified: false })
        const response = await app.inject({ method: 'POST', url, headers: auth, payload: { identityId, name: 'Denied owned home' } })
        expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400)
        expect(response.statusCode).toBeLessThan(500)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(accountCount)
        expect(await ds.getRepository(HostingEligibilityEntity).countBy({ identityId })).toBe(0)
        expect(await grants()).toEqual(before)
    })
    it.each([{ requireOwnedHome: false }, { requireOwnedHome: true }, { amount: 1000000000 }, { monthlyCredits: 1000000 }, { trialDays: 365 }])('rejects browser-controlled provisioning options %j on both operator routes', async extra => {
        const identityId = await identity(), before = await grants(), accountCount = await ds.getRepository(HostingAccountEntity).count()
        for (const endpoint of ['/api/v1/hosting/operator/tenants', url]) {
            const response = await app.inject({ method: 'POST', url: endpoint, headers: await headers(), payload: { identityId, name: 'Strict owned home', ...extra } })
            expect(response.statusCode, response.body).toBe(400)
        }
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(accountCount)
        expect(await ds.getRepository(HostingEligibilityEntity).countBy({ identityId })).toBe(0)
        expect(await grants()).toEqual(before)
    })
})
