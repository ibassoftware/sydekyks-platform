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
import { HostingGrantEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createLearningFulfillment } from '../../src/app/hosting/hosting-learning-fulfillment'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedTraining } from '../../src/app/hosting/hosting-training'
import { HostingTrainingEntity } from '../../src/app/hosting/hosting-training-entity'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../src/app/lms/lms-content'
import { lmsController } from '../../src/app/lms/lms-controller'
import { LmsCertificateEntity, LmsCourseEntity, LmsEnrollmentEntity } from '../../src/app/lms/lms-entities'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, app: FastifyInstance, oldConnection: unknown
let operator: Workspace, client: Workspace, other: Workspace
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-course-access-subject-secret-at-least32characters' })
type Workspace = { identityId: string, platformId: string, userId: string, tokenVersion: string | null }
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
async function enroll(value: Workspace, courseId: string, identityId = client.identityId) {
    const response = await request(value, '/operator/enroll', { accessType: 'learning', identityId, courseId })
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
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const identityId = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), identityId)
    operator = { ...home, identityId }; vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', identityId)
    client = await workspace('Synthetic client'); other = await workspace('Synthetic other client')
})

describe('multi-course access with real persisted authorities', () => {
    it('publishes a one-lesson end-user course without a bank, exam or hosting grants', async () => {
        const grants = await ds.getRepository(HostingGrantEntity).count()
        const course = await createCourse(); await publish(client, course)
        const enrollment = await enroll(client, course.id)
        expect(enrollment).toMatchObject({ accessType: 'learning', grantPlatformId: client.platformId, package: null, paymentReference: null, workspacePlatformId: null })
        const state = await request(client, `/enrollments/${enrollment.id}`)
        expect(state.statusCode, state.body).toBe(200)
        expect(state.json().course.certificationMode).toBe('none')
        expect(state.json().course.questions).toBeUndefined()
        expect((await request(client, `/enrollments/${enrollment.id}/exam/start`, {})).statusCode).toBe(403)
        expect((await request(operator, `/operator/enrollments/${enrollment.id}/certify`, {})).statusCode).toBe(403)
        await expect(createLearningFulfillment({ dataSource: ds }).activate({ actor: actor(operator), enrollmentId: enrollment.id })).rejects.toThrow('PARTNER_TRAINING_REQUIRED')
        await expect(createHostedTraining({ dataSource: ds }).activate({ actor: actor(operator), platformId: client.platformId, identityId: client.identityId, enrollmentId: enrollment.id, receiptId: 'fabricated', tier: 'core' })).rejects.toThrow('PARTNER_TRAINING_REQUIRED')
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
        expect(await ds.getRepository(LmsCertificateEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingGrantEntity).count()).toBe(grants)
    })
    it('isolates progress and lesson IDs between two explicit enrollments and removes legacy fallback', async () => {
        const a = await createCourse(), b = await createCourse(); await publish(client, a); await publish(client, b)
        const ea = await enroll(client, a.id), eb = await enroll(client, b.id)
        expect((await request(client, '/me')).json().enrollments).toHaveLength(2)
        expect((await request(client, `/enrollments/${ea.id}/progress`, { lessonId: a.content.lessons[0].id, completed: true })).statusCode).toBe(200)
        expect((await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: eb.id })).completedLessons).toEqual([])
        expect((await request(client, `/enrollments/${eb.id}/progress`, { lessonId: a.content.lessons[0].id, completed: true })).statusCode).toBe(404)
        expect((await request(client, '/progress', { lessonId: a.content.lessons[0].id, completed: true })).statusCode).toBe(404)
        for (const path of ['', '/exam/current']) expect((await request(other, `/enrollments/${ea.id}${path}`)).statusCode).toBe(403)
    })
    it('allows only own-private management and eligible own-user grants by tenant admins', async () => {
        const privateCourse = await createCourse(); await publish(client, privateCourse)
        expect((await request(other, '/operator/courses')).json()).toEqual([])
        expect((await request(other, `/operator/course/${privateCourse.id}`, { expectedRevision: 1, content: privateCourse.content }, 'PUT')).statusCode).toBe(403)
        expect((await request(other, '/operator/enroll', { accessType: 'learning', identityId: other.identityId, courseId: privateCourse.id })).statusCode).toBe(403)
        expect((await request(client, '/operator/enroll', { accessType: 'learning', identityId: other.identityId, courseId: privateCourse.id })).statusCode).toBe(403)
        expect((await request(client, '/operator/courses', { title: 'Forbidden partner', scope: 'global', audience: 'partner', certificationMode: 'partner' })).statusCode).toBe(403)
        expect((await request(client, '/operator/courses', { title: 'Forbidden private partner', scope: 'tenant', audience: 'partner', certificationMode: 'partner' })).statusCode).toBe(400)
    })
    it('lets central operators oversee a private course while deriving recipient scope from its owner', async () => {
        const course = await createCourse(operator, 'tenant', 'end_user', client.platformId); await publish(operator, course)
        const enrollment = await enroll(operator, course.id)
        expect(enrollment.grantPlatformId).toBe(client.platformId)
        expect((await request(operator, `/operator/members?courseId=${course.id}`)).json().map((row: { identityId: string }) => row.identityId)).toEqual([client.identityId])
        expect((await request(operator, '/operator/enroll', { accessType: 'learning', identityId: other.identityId, courseId: course.id })).statusCode).toBe(403)
        expect((await request(operator, '/me')).json().enrollments).toEqual([])
    })
    it('keeps shared end-user course access scoped separately for the same identity in two tenants', async () => {
        const membershipId = apId()
        await ds.getRepository(UserEntity).insert({ id: membershipId, identityId: client.identityId, platformId: other.platformId, platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE })
        const course = await createCourse(operator, 'global'); await publish(operator, course)
        const a = await enroll(client, course.id), b = await enroll(other, course.id)
        expect(a.id).not.toBe(b.id)
        const otherSession = { ...client, userId: membershipId, platformId: other.platformId }
        expect((await request(otherSession, '/me')).json().enrollments.map((row: { id: string }) => row.id)).toEqual([b.id])
        expect((await request(otherSession, `/enrollments/${a.id}`)).statusCode).toBe(403)
        expect((await request(otherSession, `/enrollments/${b.id}`)).statusCode).toBe(200)
        await ds.getRepository(UserEntity).update({ id: membershipId }, { status: UserStatus.INACTIVE })
        expect((await request(otherSession, `/enrollments/${b.id}`)).statusCode).toBe(403)
    })
    it('uses revision checks and immutable publication to prevent lost review edits', async () => {
        const course = await createCourse()
        const content = { ...course.content, title: 'Reviewed client training' }
        expect((await request(client, `/operator/course/${course.id}`, { expectedRevision: 1, content }, 'PUT')).statusCode).toBe(200)
        expect((await request(client, `/operator/course/${course.id}`, { expectedRevision: 1, content: course.content }, 'PUT')).statusCode).toBe(409)
        expect((await request(client, `/operator/course/${course.id}/publish`, { revision: 1, reviewedLessonsAndQuestions: true })).statusCode).toBe(409)
        await publish(client, { ...course, revision: 2 })
        expect((await request(client, `/operator/course/${course.id}`, { expectedRevision: 2, content }, 'PUT')).statusCode).toBe(403)
    })
    it('retains rigorous global-partner publication and trusted paid-enrollment requirements', async () => {
        const course = await createCourse(operator, 'global', 'partner')
        expect(course.content.questions).toHaveLength(60)
        const content = { ...foundingCourseDraft, questions: foundingCourseDraft.questions.slice(0, 59) }
        expect((await request(operator, `/operator/course/${course.id}`, { expectedRevision: 1, content }, 'PUT')).statusCode).toBe(200)
        expect((await request(operator, `/operator/course/${course.id}/publish`, { revision: 2, reviewedLessonsAndQuestions: true })).statusCode).toBe(400)
        expect((await request(operator, `/operator/course/${course.id}`, { expectedRevision: 2, content: foundingCourseDraft }, 'PUT')).statusCode).toBe(200)
        await publish(operator, { ...course, revision: 3 })
        expect((await request(client, '/operator/enroll', { accessType: 'partner_training', identityId: client.identityId, courseId: course.id, package: 'core', paymentReference: 'synthetic-receipt', workspacePlatformId: client.platformId, paymentVerified: true })).statusCode).toBe(403)
        expect((await request(operator, '/operator/enroll', { accessType: 'learning', identityId: client.identityId, courseId: course.id })).statusCode).toBe(403)
    })
    it('rejects client financial/scope injection and checks DB private-course invariants', async () => {
        const course = await createCourse(); await publish(client, course)
        for (const extra of [{ package: 'core' }, { paymentReference: 'fake' }, { workspacePlatformId: client.platformId }, { grantPlatformId: other.platformId }, { monthlyCredits: 1000000 }]) expect((await request(client, '/operator/enroll', { accessType: 'learning', identityId: client.identityId, courseId: course.id, ...extra })).statusCode).toBe(400)
        await expect(ds.getRepository(LmsCourseEntity).update({ id: course.id }, { certificationMode: 'partner' })).rejects.toThrow()
        expect(await ds.getRepository(LmsEnrollmentEntity).count()).toBe(0)
    })
})
