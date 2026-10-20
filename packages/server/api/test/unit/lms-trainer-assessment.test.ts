import { apId } from '@activepieces/core-utils'
import { PrincipalType } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessTokenManager } from '../../src/app/authentication/lib/access-token-manager'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { authenticationMiddleware } from '../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { createHostedAiAllowance } from '../../src/app/hosting/hosting-ai-allowance'
import { createHostedAssessment } from '../../src/app/hosting/hosting-assessment'
import { HostingAssessmentEntity } from '../../src/app/hosting/hosting-assessment-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createLearningFulfillment } from '../../src/app/hosting/hosting-learning-fulfillment'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { HostingTrainerAssignmentEntity, HostingTrainerRoleEntity } from '../../src/app/hosting/hosting-trainer-entities'
import { HostingTrainingEntity } from '../../src/app/hosting/hosting-training-entity'
import { HostingActor, hostingTransactions } from '../../src/app/hosting/hosting-transactions'
import { lmsController } from '../../src/app/lms/lms-controller'
import { LmsCertificateEntity, LmsEnrollmentEntity, LmsExamAttemptEntity } from '../../src/app/lms/lms-entities'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, app: FastifyInstance, oldConnection: unknown
let operator: Workspace, client: Workspace, other: Workspace
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-course-access-subject-secret-at-least32characters' })
type Workspace = { projectId?: string | null, identityId: string, platformId: string, userId: string, tokenVersion: string | null }
const actor = (value: Workspace): HostingActor => ({ identityId: value.identityId, platformId: value.platformId, tokenVersion: value.tokenVersion })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', verified: true, password: 'unused', firstName: 'Course', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
async function workspace(name: string): Promise<Workspace> {
    const identityId = await identity(), result = await onboarding().provision({ identityId, name, operator: actor(operator) })
    return { ...result, identityId }
}
async function headers(value: Workspace) {
    const token = await accessTokenManager(app.log).generateToken({ id: value.userId, platform: { id: value.platformId }, type: PrincipalType.USER, tokenVersion: value.tokenVersion })
    return { authorization: `Bearer ${token}` }
}
async function request(value: Workspace, path: string, payload?: unknown, method?: 'POST' | 'PUT') {
    return app.inject({ method: method ?? (payload === undefined ? 'GET' : 'POST'), url: `/api/v1/lms${path}`, headers: await headers(value), ...(payload === undefined ? {} : { payload }) })
}
async function createCourse(value = client, scope: 'global' | 'tenant' = 'tenant', audience: 'partner' | 'end_user' = 'end_user', ownerPlatformId?: string) {
    const response = await request(value, '/operator/courses', { title: `Synthetic ${scope} ${audience} course`, scope, audience, certificationMode: audience === 'partner' ? 'partner' : 'none', ...(ownerPlatformId ? { ownerPlatformId } : {}) })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
}
async function publish(value: Workspace, course: { id: string, revision: number }) {
    const response = await request(value, `/operator/course/${course.id}/publish`, { revision: course.revision, reviewedLessonsAndQuestions: true })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
}
beforeAll(async () => {
    ds = await migratedHostedPGlite()
    oldConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__'); Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
    app.addHook('preHandler', authenticationMiddleware); app.addHook('preHandler', authorizationMiddleware)
    await app.register(lmsController, { prefix: '/api/v1/lms' }); await app.ready()
})
afterAll(async () => {
    if (app) await app.close(); Reflect.set(globalThis, '__AP_DB_CONNECTION__', oldConnection); if (ds?.isInitialized) await ds.destroy() 
})
afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs() 
})
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const identityId = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), identityId)
    operator = { ...home, identityId }; vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', identityId)
    client = await workspace('Synthetic client'); other = await workspace('Synthetic other client')
})


const days = 86400000
async function trainer(partner = client, assignedClient = client) {
    await ds.getRepository(HostingTrainerRoleEntity).insert({ id: other.identityId, active: true, revision: 1, accessVersion: 1 })
    await ds.getRepository(HostingAccessRoleEntity).insert({ id: partner.identityId, role: 'partner', active: true })
    await ds.getRepository(HostingTrainerAssignmentEntity).insert([
        { id: apId(), trainerIdentityId: other.identityId, kind: 'partner', partnerIdentityId: partner.identityId, clientPlatformId: null, active: true, revision: 1, provenance: 'operator', createdByIdentityId: operator.identityId, userId: null },
        { id: apId(), trainerIdentityId: other.identityId, kind: 'client', partnerIdentityId: null, clientPlatformId: assignedClient.platformId, active: true, revision: 1, provenance: 'operator', createdByIdentityId: operator.identityId, userId: null },
    ])
    return other
}
async function partnerCourse() {
    const course = await createCourse(operator, 'global', 'partner')
    await publish(operator, course)
    return course
}
async function courseOnly(value: Workspace, courseId: string, identityId = client.identityId) {
    return request(value, '/operator/enroll', { accessType: 'partner_course', courseId, identityId })
}
async function paidCore(tier: 'core' | 'launch' = 'core') {
    const course = await partnerCourse()
    const response = await request(operator, '/operator/enroll', { accessType: 'partner_training', courseId: course.id, identityId: client.identityId, package: tier, paymentReference: `synthetic-${apId()}`, workspacePlatformId: client.platformId, paymentVerified: true })
    expect(response.statusCode, response.body).toBe(200)
    const enrollment = response.json()
    // Explicit pre-upgrade funding: this suite exercises the retained day61
    // assessment fallback, which new twelve-month Partner packages never need.
    const startsAt = new Date(enrollment.startsAt), periods = tier === 'core' ? 2 : 3
    const endsAt = new Date(startsAt.getTime() + periods * 30 * days)
    const record = await ds.getRepository(HostingTrainingEntity).save({ id: apId(), enrollmentId: enrollment.id, receiptId: enrollment.paymentReference, platformId: client.platformId, identityId: client.identityId, tier, operatorIdentityId: operator.identityId, startsAt, endsAt, revokedAt: null })
    for (let period = 0; period < periods; period++) {
        for (const [meter, amount] of [['execution', 1000n], ['managed_ai', 5000000n]] as const) {
            const id = apId()
            await ds.getRepository(HostingGrantEntity).insert({ id, platformId: client.platformId, sourceKey: `training:${record.id}:${period}`, meter, amount, consumed: 0n, reserved: 0n, validFrom: new Date(startsAt.getTime() + period * 30 * days), validUntil: new Date(startsAt.getTime() + (period + 1) * 30 * days) })
            await ds.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: client.platformId, grantId: id, reservationId: null, operation: 'grant', key: `grant:${id}`, amount })
        }
    }
    await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'training', status: 'active', catalogVersion: '2026-10-15.v1', validUntil: endsAt })
    const delivered = { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }
    return { course, enrollment, delivered, start: startsAt.getTime() }
}
const assessment = () => createHostedAssessment({ dataSource: ds })
const activate = (id: string, who = operator) => assessment().activate({ actor: actor(who), enrollmentId: id })
const grants = () => ds.getRepository(HostingGrantEntity).find({ where: { platformId: client.platformId }, order: { id: 'ASC' } })

describe('Trainer course-only authority and paid conversion', () => {
    it('grants only assigned partner course access without finance, hosting credits, self grants or global authoring', async () => {
        const teacher = await trainer(), course = await partnerCourse(), before = await grants()
        const granted = await courseOnly(teacher, course.id)
        expect(granted.statusCode, granted.body).toBe(200)
        expect(granted.json()).toMatchObject({ accessType: 'partner_course', package: null, paymentReference: null, workspacePlatformId: null, grantPlatformId: null })
        expect(await grants()).toEqual(before)
        const catalogue = await request(teacher, '/operator/courses')
        expect(catalogue.json().find((row: { id: string }) => row.id === course.id)).toMatchObject({ canEdit: false, content: { questions: [] } })
        expect((await request(teacher, `/operator/course/${course.id}`, { expectedRevision: 1, content: course.content }, 'PUT')).statusCode).toBe(403)
        expect((await courseOnly(teacher, course.id, teacher.identityId)).statusCode).toBe(403)
        expect((await courseOnly(teacher, course.id, operator.identityId)).statusCode).toBe(403)
        expect((await request(teacher, '/operator/enroll', { accessType: 'partner_training', courseId: course.id, identityId: client.identityId, package: 'core', paymentReference: 'not-attested', workspacePlatformId: client.platformId, paymentVerified: true })).statusCode).toBe(403)
        await expect(createLearningFulfillment({ dataSource: ds }).activate({ actor: actor(operator), enrollmentId: granted.json().id })).rejects.toThrow('PARTNER_TRAINING_REQUIRED')
        await expect(createLearningFulfillment({ dataSource: ds }).bindWorkspace({ actor: actor(operator), enrollmentId: granted.json().id, workspacePlatformId: client.platformId, expectedWorkspacePlatformId: null })).rejects.toThrow('PARTNER_TRAINING_REQUIRED')
    })
    it('restricts private authoring to assigned clients and prevents own-home/inactive-role administrator fallback', async () => {
        const teacher = await trainer()
        const scoped = await request(teacher, '/operator/courses', { title: 'Assigned client lessons', scope: 'tenant', ownerPlatformId: client.platformId, audience: 'end_user', certificationMode: 'none' })
        expect(scoped.statusCode, scoped.body).toBe(200)
        expect(scoped.json().ownerPlatformId).toBe(client.platformId)
        expect((await request(teacher, '/operator/courses', { title: 'Unassigned own home', scope: 'tenant', audience: 'end_user', certificationMode: 'none' })).statusCode).toBe(403)
        await ds.getRepository(HostingTrainerRoleEntity).update({ id: teacher.identityId }, { active: false })
        expect((await request(teacher, '/operator/courses')).statusCode).toBe(403)
        expect((await request(teacher, '/operator/courses', { title: 'Inactive fallback', scope: 'tenant', audience: 'end_user', certificationMode: 'none' })).statusCode).toBe(403)
    })
    it('filters portfolio recipients before the newest100 limit and immediately drops removed assignments', async () => {
        const teacher = await trainer(), course = await partnerCourse(), granted = await courseOnly(teacher, course.id)
        const old = granted.json()
        for (let index = 0; index < 101; index++) {
            const identityId = await identity(), now = new Date()
            await ds.getRepository(LmsEnrollmentEntity).insert({ id: apId(), identityId, courseId: course.id, grantPlatformId: null, accessType: 'partner_course', package: null, paymentReference: null, workspacePlatformId: null, startsAt: now, accessUntil: new Date(now.getTime() + 365 * days), assessmentUntil: new Date(now.getTime() + 90 * days), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: operator.identityId, created: new Date(now.getTime() + index + 1000).toISOString() })
        }
        const list = await request(teacher, `/operator/enrollments?courseId=${course.id}`)
        expect(list.statusCode, list.body).toBe(200)
        expect(list.json()).toHaveLength(1)
        expect(list.json()[0]).toMatchObject({ id: old.id, paymentReference: null, assignment: null, practicalReviews: [], certified: false })
        await ds.getRepository(HostingTrainerAssignmentEntity).update({ trainerIdentityId: teacher.identityId, kind: 'partner' }, { active: false })
        expect((await request(teacher, `/operator/enrollments?courseId=${course.id}`)).json()).toEqual([])
        expect((await request(client, `/enrollments/${old.id}`)).statusCode).toBe(200)
    })
    it('converts the same course enrollment only by a central operator and preserves exam/progress/credential history', async () => {
        const teacher = await trainer(), course = await partnerCourse(), granted = await courseOnly(teacher, course.id), enrollment = granted.json()
        for (const lesson of course.content.lessons) expect((await request(client, `/enrollments/${enrollment.id}/progress`, { lessonId: lesson.id, completed: true })).statusCode).toBe(200)
        const started = await request(client, `/enrollments/${enrollment.id}/exam/start`, {}), exam = started.json()
        expect(started.statusCode, started.body).toBe(200)
        const stored = await ds.getRepository(LmsExamAttemptEntity).findOneByOrFail({ id: exam.id })
        const correct = Object.fromEntries(stored.questions.map(question => [question.id, question.correctIndex]))
        expect((await request(client, `/enrollments/${enrollment.id}/exam/submit`, { attemptId: exam.id, answers: correct })).json().passed).toBe(true)
        const submission = 'Synthetic independently reviewed capstone. '.repeat(8)
        expect((await request(client, `/enrollments/${enrollment.id}/assignment`, { submission })).statusCode).toBe(200)
        const review = { score: 90, safety: { credentials: true, isolation: true, spending: true, recovery: true, humanApproval: true }, feedback: 'Synthetic safe demonstration reviewed independently.', walkthroughCompleted: true }
        expect((await request(teacher, `/operator/enrollments/${enrollment.id}/review`, review)).statusCode).toBe(403)
        expect((await request(operator, `/operator/enrollments/${enrollment.id}/review`, review)).statusCode).toBe(200)
        const certificate = await request(operator, `/operator/enrollments/${enrollment.id}/certify`, {})
        expect(certificate.statusCode, certificate.body).toBe(200)
        expect((await request(teacher, `/operator/enrollments/${enrollment.id}/revoke`, {})).json().code).toBe('LMS_CERTIFIED_ENROLLMENT_OPERATOR_REQUIRED')
        const before = await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: enrollment.id }), beforeExam = await ds.getRepository(LmsExamAttemptEntity).findOneByOrFail({ id: exam.id })
        const conversion = { expectedPriorAccessType: 'partner_course', package: 'core', paymentReference: 'synthetic-conversion-receipt', workspacePlatformId: client.platformId, paymentVerified: true }
        expect((await request(teacher, `/operator/enrollments/${enrollment.id}/convert-training`, conversion)).statusCode).toBe(403)
        const converted = await request(operator, `/operator/enrollments/${enrollment.id}/convert-training`, conversion)
        expect(converted.statusCode, converted.body).toBe(200)
        expect(converted.json().id).toBe(enrollment.id)
        const after = await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: enrollment.id })
        expect(after.completedLessons).toEqual(before.completedLessons); expect(after.practicalReviews).toEqual(before.practicalReviews); expect(after.startsAt).toEqual(before.startsAt); expect(after.assessmentUntil).toEqual(before.assessmentUntil)
        expect(await ds.getRepository(LmsExamAttemptEntity).findOneByOrFail({ id: exam.id })).toEqual(beforeExam)
        expect(await ds.getRepository(LmsCertificateEntity).count()).toBe(1)
        expect((await request(operator, `/operator/enrollments/${enrollment.id}/convert-training`, conversion)).statusCode).toBe(200)
        expect((await request(operator, `/operator/enrollments/${enrollment.id}/convert-training`, { ...conversion, paymentReference: 'conflicting' })).statusCode).toBe(409)
        await createLearningFulfillment({ dataSource: ds }).activate({ actor: actor(operator), enrollmentId: enrollment.id })
        expect(await ds.getRepository(LmsExamAttemptEntity).findOneByOrFail({ id: exam.id })).toEqual(beforeExam)
        expect(await ds.getRepository(LmsCertificateEntity).count()).toBe(1)
    })
    it('cannot convert revoked course-only rows or revive them using a paid replay', async () => {
        const teacher = await trainer(), course = await partnerCourse(), granted = await courseOnly(teacher, course.id), id = granted.json().id
        expect((await request(teacher, `/operator/enrollments/${id}/revoke`, {})).statusCode).toBe(200)
        expect((await request(operator, `/operator/enrollments/${id}/convert-training`, { expectedPriorAccessType: 'partner_course', package: 'core', paymentReference: 'synthetic-revoked', workspacePlatformId: client.platformId, paymentVerified: true })).statusCode).toBe(403)
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
    })
})

describe('one-time Core assessment allowance', () => {
    it('creates exactly100 execution credits and $1 at day61 without rewriting old grants or dates', async () => {
        const { enrollment, delivered, start } = await paidCore(), before = await grants()
        vi.spyOn(hostingTransactions, 'now').mockResolvedValue(new Date(start + 61 * days))
        const record = await activate(enrollment.id)
        expect(record.endsAt.toISOString()).toBe(new Date(start + 90 * days).toISOString())
        expect(record.startsAt.toISOString()).toBe(new Date(start + 61 * days).toISOString())
        const all = await grants(), issued = all.filter(grant => grant.sourceKey === `assessment:${record.id}`)
        expect(issued).toHaveLength(2)
        expect(issued.find(grant => grant.meter === 'execution')?.amount).toBe(100n)
        expect(issued.find(grant => grant.meter === 'managed_ai')?.amount).toBe(1000000n)
        await expect(ds.getRepository(HostingGrantEntity).update({ id: issued.find(grant => grant.meter === 'managed_ai')!.id }, { amount: 1000001n })).rejects.toThrow()
        expect(all.filter(grant => !grant.sourceKey.startsWith('assessment:'))).toEqual(before)
        expect((await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: enrollment.id })).assessmentUntil.toISOString()).toBe(new Date(start + 90 * days).toISOString())
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId }))).toMatchObject({ planId: 'assessment', validUntil: record.endsAt })
        expect(Date.parse(delivered.endsAt)).toBe(start + 60 * days)
        const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor: actor(client), projectId: client.projectId!, key: 'assessment-source', payer: 'managed' })
        expect(root.grantId).toBe(issued.find(grant => grant.meter === 'execution')?.id)
        const rootClaim = await ledger.claimExecution({ actor: actor(client), reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: actor(client), rootReservationId: root.id, key: 'last-assessment-credits', maxCostMicroUsd: 49500n })
        await expect(ledger.reserveManagedCall({ actor: actor(client), rootReservationId: root.id, key: 'over-shared-credit-balance', maxCostMicroUsd: 1n })).rejects.toThrow('CREDITS_EXHAUSTED')
        const claim = await ledger.claimManagedCall({ actor: actor(client), reservationId: call.id })
        await ledger.settleManagedCall({ platformId: client.platformId, reservationId: call.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 49500n })
        await ledger.finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
        expect((await activate(enrollment.id)).id).toBe(record.id)
        expect(await ds.getRepository(HostingAssessmentEntity).count()).toBe(1)
        expect((await grants()).filter(grant => grant.sourceKey.startsWith('assessment:'))).toHaveLength(2)
        expect((await grants()).find(grant => grant.id === call.grantId)?.consumed).toBe(100n)
        await expect(createHostedAiAllowance({ dataSource: ds }).save({ actor: actor(operator), input: { platformId: client.platformId, expectedRevision: 0, requestKey: 'forbidden-increase', monthlyCredits: 1000000 } })).rejects.toThrow('HOSTING_AI_ALLOWANCE_RETIRED')
    })
    it.each(['too-early', 'day90', 'launch', 'nonoperator', 'suspended', 'paid-account'] as const)('denies %s without minting or altering old grants', async reason => {
        const { enrollment, start } = await paidCore(reason === 'launch' ? 'launch' : 'core'), before = await grants()
        vi.spyOn(hostingTransactions, 'now').mockResolvedValue(new Date(start + (reason === 'too-early' ? 59 : reason === 'day90' ? 90 : 61) * days))
        if (reason === 'suspended') await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { status: 'suspended' })
        if (reason === 'paid-account') await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'starter' })
        await expect(activate(enrollment.id, reason === 'nonoperator' ? client : operator)).rejects.toThrow()
        expect(await ds.getRepository(HostingAssessmentEntity).count()).toBe(0)
        expect(await grants()).toEqual(before)
    })
    it('revokes old-session admission without dropping held liability and cannot replay or modify history', async () => {
        const { enrollment, start } = await paidCore()
        const clock = vi.spyOn(hostingTransactions, 'now').mockResolvedValue(new Date(start + 61 * days)), record = await activate(enrollment.id)
        const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor: actor(client), projectId: client.projectId!, key: 'held-assessment', payer: 'managed' }), rootClaim = await ledger.claimExecution({ actor: actor(client), reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: actor(client), rootReservationId: root.id, key: 'held-before-revoke', maxCostMicroUsd: 5000n }), claim = await ledger.claimManagedCall({ actor: actor(client), reservationId: call.id })
        await assessment().revoke({ actor: actor(operator), enrollmentId: enrollment.id })
        expect((await grants()).find(grant => grant.id === call.grantId)?.reserved).toBe(10n)
        await expect(ledger.reserveExecution({ actor: actor(client), projectId: client.projectId!, key: 'old-session-after-revoke', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
        await ledger.settleManagedCall({ platformId: client.platformId, reservationId: call.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 2000n })
        await ledger.finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
        expect((await grants()).find(grant => grant.id === call.grantId)?.consumed).toBe(5n)
        await expect(activate(enrollment.id)).rejects.toThrow('ASSESSMENT_CLOSED')
        await expect(ds.getRepository(HostingAssessmentEntity).update({ id: record.id }, { endsAt: new Date(start + 91 * days) })).rejects.toThrow('HISTORY_IMMUTABLE')
        await expect(ds.getRepository(HostingAssessmentEntity).delete({ id: record.id })).rejects.toThrow('HISTORY_IMMUTABLE')
        clock.mockResolvedValue(new Date(start + 90 * days))
        await expect(activate(enrollment.id)).rejects.toThrow('ASSESSMENT_NOT_ELIGIBLE')
    })
    it('refreshes server time after the account lock before admitting a day90-boundary request', async () => {
        const { enrollment, start } = await paidCore()
        vi.spyOn(hostingTransactions, 'now').mockResolvedValueOnce(new Date(start + 90 * days - 1)).mockResolvedValue(new Date(start + 90 * days))
        await expect(activate(enrollment.id)).rejects.toThrow('ASSESSMENT_NOT_ELIGIBLE')
        expect(await ds.getRepository(HostingAssessmentEntity).count()).toBe(0)
    })
    it('does not erase or replace unresolved training liabilities when opening assessment access', async () => {
        const { enrollment, start } = await paidCore()
        const clock = vi.spyOn(hostingTransactions, 'now').mockResolvedValue(new Date(start + 59 * days))
        const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor: actor(client), projectId: client.projectId!, key: 'old-training-hold', payer: 'managed' })
        await ledger.claimExecution({ actor: actor(client), reservationId: root.id })
        await ledger.reserveManagedCall({ actor: actor(client), rootReservationId: root.id, key: 'unresolved-training-cost', maxCostMicroUsd: 100n })
        clock.mockResolvedValue(new Date(start + 61 * days))
        const before = await grants()
        await expect(activate(enrollment.id)).rejects.toThrow('ASSESSMENT_REQUIRES_REVIEW')
        expect(await grants()).toEqual(before)
        expect(await ds.getRepository(HostingAssessmentEntity).count()).toBe(0)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })).validUntil.toISOString()).toBe(new Date(start + 60 * days).toISOString())
    })
    it('whole enrollment revocation closes assessment access in the same transaction', async () => {
        const { enrollment, start } = await paidCore()
        vi.spyOn(hostingTransactions, 'now').mockResolvedValue(new Date(start + 61 * days))
        const record = await activate(enrollment.id)
        await createLearningFulfillment({ dataSource: ds }).revoke({ actor: actor(operator), enrollmentId: enrollment.id })
        expect((await ds.getRepository(HostingAssessmentEntity).findOneByOrFail({ id: record.id })).revokedAt).not.toBeNull()
        expect((await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: enrollment.id })).status).toBe('revoked')
        expect((await grants()).filter(grant => grant.sourceKey.startsWith('assessment:')).every(grant => grant.revokedAt)).toBe(true)
    })
})
