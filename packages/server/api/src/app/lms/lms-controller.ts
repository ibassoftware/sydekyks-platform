import { ActivepiecesError, apId } from '@activepieces/core-utils'
import { PrincipalType, UserStatus } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { In, IsNull } from 'typeorm'
import { z } from 'zod'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { databaseConnection } from '../database/database-connection'
import { isOperationalUser } from '../hosting/hosting-access-policy'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { assertLearningWorkspaceOwner, createLearningFulfillment } from '../hosting/hosting-learning-fulfillment'
import { HostingTrainingEntity } from '../hosting/hosting-training-entity'
import { HostingError, hostingTransactions as tx } from '../hosting/hosting-transactions'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { foundingCourseDraft } from './lms-content'
import { LmsCertificateEntity, LmsCourseEntity, LmsEnrollmentEntity, LmsExamAttemptEntity } from './lms-entities'
import { courseContentSchema, safetySchema } from './lms-schema'
import { assertCanEnroll, assertManageCourse, assertOrdinaryRecipient, assertPartnerAssessment, canManageCourse, checkAnswers, courseForEnrollment, examQuestions, expireAttempt, fail, finishExam, learnerEnrollment, learnerScope, LmsError, lmsTransaction, maybeCertificate, publicAttempt, requireManager, requireOperator, validatePublication } from './lms-service'

const id = z.string().length(21)
const answersSchema = z.record(z.string().min(1).max(80), z.number().int().min(0).max(3)).refine(answers => Object.keys(answers).length <= 30)
const enrollmentParams = z.object({ id })
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 86400000)

export const lmsController: FastifyPluginAsyncZod = async app => {
    const config = { security: securityAccess.unscoped([PrincipalType.USER]) }
    app.addHook('onRequest', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store') 
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof LmsError) return reply.code(error.status).send({ code: error.message })
        if (error instanceof HostingError) return reply.code(error.message === 'HOSTING_LEARNING_WORKSPACE_CHANGED' ? 409 : 403).send({ code: error.message })
        if (error instanceof ActivepiecesError) return reply.code(403).send({ code: error.error.code })
        if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error)) return reply.code(400).send({ code: 'LMS_INVALID_REQUEST' })
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return reply.code(409).send({ code: 'LMS_RECORD_CONFLICT' })
        return reply.code(500).send({ code: 'LMS_UNAVAILABLE' })
    })
    app.get('/me', { config }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const rows = await manager.getRepository(LmsEnrollmentEntity).find({ where: { identityId: actor.identityId, status: 'active' }, order: { created: 'ASC' } })
        const enrollments = []
        for (const enrollment of rows.filter(row => learnerScope(actor, row) && row.startsAt <= now && row.accessUntil > now)) {
            const course = await courseForEnrollment(manager, enrollment)
            enrollments.push({ id: enrollment.id, courseId: course.id, title: course.content.title, audience: course.audience, certificationMode: course.certificationMode, grantPlatformId: enrollment.grantPlatformId })
        }
        return { operator: actor.operator, canManage: actor.operator || actor.tenantAdmin, enrollments }
    }))
    app.get('/enrollments/:id', { config, schema: { params: enrollmentParams } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, request.params.id)
        const course = await courseForEnrollment(manager, enrollment)
        const attempts = course.certificationMode === 'partner' ? await manager.getRepository(LmsExamAttemptEntity).find({ where: { enrollmentId: enrollment.id }, order: { ordinal: 'ASC' } }) : []
        return { operator: actor.operator, enrollment, course: { id: course.id, revision: course.revision, audience: course.audience, certificationMode: course.certificationMode, title: course.content.title, description: course.content.description, lessons: course.content.lessons }, certificate: course.certificationMode === 'partner' ? await manager.getRepository(LmsCertificateEntity).findOneBy({ enrollmentId: enrollment.id }) : null, attempts: attempts.map(attempt => ({ id: attempt.id, ordinal: attempt.ordinal, deadline: attempt.deadline, score: attempt.score, passed: attempt.passed, submittedAt: attempt.submittedAt })) }
    }))
    app.post('/enrollments/:id/progress', { config, schema: { params: enrollmentParams, body: z.object({ lessonId: z.string().max(80), completed: z.boolean() }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, request.params.id)
        const course = await courseForEnrollment(manager, enrollment)
        if (!course.content.lessons.some(lesson => lesson.id === request.body.lessonId)) fail('LMS_LESSON_NOT_FOUND', 404)
        enrollment.completedLessons = request.body.completed ? [...new Set([...enrollment.completedLessons, request.body.lessonId])] : enrollment.completedLessons.filter(value => value !== request.body.lessonId)
        await manager.getRepository(LmsEnrollmentEntity).save(enrollment)
        return { completedLessons: enrollment.completedLessons }
    }))
    app.post('/enrollments/:id/assignment', { config, schema: { params: enrollmentParams, body: z.object({ submission: z.string().trim().min(100).max(30000) }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, request.params.id, true)
        if (enrollment.practicalReviews.at(-1)?.passed || enrollment.practicalReviews.length >= 2) fail('LMS_PRACTICAL_ATTEMPTS_EXHAUSTED')
        if (enrollment.assignment && (!enrollment.practicalReviews.at(-1) || (enrollment.practicalReviews.at(-1)?.reviewedAt ?? '') < enrollment.assignment.submittedAt)) fail('LMS_PRACTICAL_AWAITING_REVIEW')
        enrollment.assignment = { submission: request.body.submission, submittedAt: now.toISOString() }
        await manager.getRepository(LmsEnrollmentEntity).save(enrollment)
        return enrollment.assignment
    }))
    app.post('/enrollments/:id/exam/start', { config, schema: { params: enrollmentParams } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, request.params.id, true)
        const attempts = await manager.getRepository(LmsExamAttemptEntity).find({ where: { enrollmentId: enrollment.id }, order: { ordinal: 'ASC' } })
        const last = attempts.at(-1) ?? null
        await expireAttempt(manager, last, now)
        if (last && !last.submittedAt) return publicAttempt(last, now)
        if (attempts.some(attempt => attempt.passed) || attempts.length >= 2) fail('LMS_EXAM_ATTEMPTS_EXHAUSTED')
        const course = await courseForEnrollment(manager, enrollment)
        if (!course.reviewedAt || course.content.questions.length < 60) fail('LMS_QUESTION_BANK_NOT_REVIEWED')
        if (!course.content.lessons.every(lesson => enrollment.completedLessons.includes(lesson.id))) fail('LMS_COMPLETE_LESSONS_FIRST')
        const attempt = await manager.getRepository(LmsExamAttemptEntity).save({ id: apId(), enrollmentId: enrollment.id, ordinal: attempts.length + 1, courseRevision: course.revision, questions: examQuestions(course.content.questions), answers: {}, startedAt: now, deadline: new Date(Math.min(addDays(now, 45 / 1440).getTime(), enrollment.assessmentUntil.getTime())), submittedAt: null, score: null, passed: null })
        return publicAttempt(attempt, now)
    }))
    app.get('/enrollments/:id/exam/current', { config, schema: { params: enrollmentParams } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, request.params.id)
        assertPartnerAssessment(enrollment, await courseForEnrollment(manager, enrollment))
        const attempt = await manager.getRepository(LmsExamAttemptEntity).findOne({ where: { enrollmentId: enrollment.id }, order: { ordinal: 'DESC' } })
        await expireAttempt(manager, attempt, now)
        return attempt ? publicAttempt(attempt, now) : null
    }))
    for (const action of ['save', 'submit'] as const) app.post(`/enrollments/:id/exam/${action}`, { config, schema: { params: enrollmentParams, body: z.object({ attemptId: id, answers: answersSchema }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, request.params.id)
        assertPartnerAssessment(enrollment, await courseForEnrollment(manager, enrollment))
        const attempt = await manager.getRepository(LmsExamAttemptEntity).findOneBy({ id: request.body.attemptId, enrollmentId: enrollment.id })
        if (!attempt) return fail('LMS_EXAM_NOT_FOUND', 404)
        checkAnswers(attempt, request.body.answers)
        await expireAttempt(manager, attempt, now)
        if (!attempt.submittedAt) {
            attempt.answers = request.body.answers
            if (action === 'submit') await finishExam(manager, attempt, now)
            else await manager.getRepository(LmsExamAttemptEntity).save(attempt)
        }
        return publicAttempt(attempt, now)
    }))
    app.get('/operator/courses', { config }, async request => lmsTransaction(request, async (manager, actor) => {
        requireManager(actor)
        const rows = await manager.getRepository(LmsCourseEntity).find({ order: { created: 'ASC' } })
        const ownerIds = rows.flatMap(course => course.ownerPlatformId ? [course.ownerPlatformId] : [])
        const owners = ownerIds.length ? await manager.getRepository(PlatformEntity).findBy({ id: In(ownerIds) }) : []
        return rows.filter(course => canManageCourse(actor, course) || (course.ownerPlatformId === null && course.audience === 'end_user' && course.status === 'published')).map(course => ({ ...course, ownerName: owners.find(owner => owner.id === course.ownerPlatformId)?.name ?? null, canEdit: canManageCourse(actor, course) }))
    }))
    app.post('/operator/courses', { config, schema: { body: z.strictObject({ title: z.string().trim().min(3).max(160), scope: z.enum(['global', 'tenant']), ownerPlatformId: id.optional(), audience: z.enum(['partner', 'end_user']), certificationMode: z.enum(['partner', 'none']) }) } }, async request => lmsTransaction(request, async (manager, actor) => {
        requireManager(actor)
        const body = request.body
        if (body.scope === 'global') requireOperator(actor)
        const ownerPlatformId = body.scope === 'global' ? null : actor.operator ? body.ownerPlatformId ?? actor.platformId : actor.platformId
        if (body.ownerPlatformId && body.ownerPlatformId !== ownerPlatformId) fail('LMS_COURSE_ACCESS_DENIED')
        if (ownerPlatformId && !await manager.getRepository(PlatformEntity).existsBy({ id: ownerPlatformId })) fail('LMS_WORKSPACE_NOT_FOUND', 404)
        const shape = { ownerPlatformId, audience: body.audience, certificationMode: body.certificationMode }
        const content = body.certificationMode === 'partner' ? { ...foundingCourseDraft, title: body.title } : { title: body.title, description: 'Draft course. Review the lessons before publishing.', lessons: [{ id: `lesson-${apId().toLowerCase()}`, title: 'Getting started', body: 'Replace this draft with the lesson you want to teach.', exercise: '', resources: [] }], questions: [] }
        const course = manager.getRepository(LmsCourseEntity).create({ id: apId(), slug: `course-${apId()}`, ...shape, revision: 1, status: 'draft', content, reviewedBy: null, reviewedAt: null })
        // Validate scope independently of the selected template.
        if ((ownerPlatformId !== null && (body.audience !== 'end_user' || body.certificationMode !== 'none')) || (body.certificationMode === 'partner' && body.audience !== 'partner') || (body.audience === 'partner' && body.certificationMode !== 'partner')) fail('LMS_INVALID_COURSE_SCOPE', 400)
        await manager.getRepository(LmsCourseEntity).save(course)
        if (hostingConfiguration.getServiceMode() === 'hosted') await tx.event({ manager, platformId: ownerPlatformId ?? actor.platformId, event: 'learning.course.created', payload: { courseId: course.id, ownerPlatformId, audience: course.audience, certificationMode: course.certificationMode, actorIdentityId: actor.identityId } })
        return course
    }))
    app.post('/operator/course/initialize', { config }, async request => lmsTransaction(request, async (manager, actor) => {
        requireOperator(actor)
        const repo = manager.getRepository(LmsCourseEntity)
        const existing = await repo.findOneBy({ slug: 'ai-workflow-implementer' })
        if (existing) return existing
        return repo.save({ id: apId(), slug: 'ai-workflow-implementer', ownerPlatformId: null, audience: 'partner', certificationMode: 'partner', revision: 1, status: 'draft', content: foundingCourseDraft, reviewedBy: null, reviewedAt: null })
    }))
    app.put('/operator/course/:id', { config, schema: { params: enrollmentParams, body: z.strictObject({ expectedRevision: z.number().int().positive(), content: courseContentSchema }) } }, async request => lmsTransaction(request, async (manager, actor) => {
        requireManager(actor)
        const course = await manager.getRepository(LmsCourseEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!course) return fail('LMS_COURSE_NOT_FOUND', 404)
        assertManageCourse(actor, course)
        if (course.status !== 'draft') fail('LMS_PUBLISHED_COURSE_IS_IMMUTABLE')
        if (course.revision !== request.body.expectedRevision) fail('LMS_COURSE_CHANGED_REVIEW_AGAIN', 409)
        course.content = request.body.content
        course.revision += 1
        return manager.getRepository(LmsCourseEntity).save(course)
    }))
    app.post('/operator/course/:id/publish', { config, schema: { params: enrollmentParams, body: z.object({ revision: z.number().int().positive(), reviewedLessonsAndQuestions: z.literal(true) }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireManager(actor)
        const course = await manager.getRepository(LmsCourseEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!course) return fail('LMS_COURSE_NOT_FOUND', 404)
        assertManageCourse(actor, course)
        if (request.body.revision !== course.revision) fail('LMS_COURSE_CHANGED_REVIEW_AGAIN', 409)
        if (course.status === 'published') return course
        validatePublication(course)
        course.status = 'published'
        course.reviewedBy = actor.identityId
        course.reviewedAt = now
        return manager.getRepository(LmsCourseEntity).save(course)
    }))
    app.get('/operator/members', { config, schema: { querystring: z.strictObject({ courseId: id }) } }, async request => lmsTransaction(request, async (manager, actor) => {
        requireManager(actor)
        const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: request.query.courseId })
        if (!course) return fail('LMS_COURSE_NOT_FOUND', 404)
        assertCanEnroll(actor, course)
        const platformId = course.ownerPlatformId ?? actor.platformId
        const users = await manager.getRepository(UserEntity).findBy({ platformId, status: UserStatus.ACTIVE })
        const ordinary = users.filter(user => !isOperationalUser(user))
        const identities = ordinary.length ? await manager.getRepository(UserIdentityEntity).findBy({ id: In(ordinary.map(user => user.identityId)), verified: true }) : []
        return identities.map(identity => ({ identityId: identity.id, email: identity.email, firstName: identity.firstName, lastName: identity.lastName }))
    }))
    app.get('/operator/enrollments', { config, schema: { querystring: z.strictObject({ courseId: id }) } }, async request => lmsTransaction(request, async (manager, actor) => {
        requireManager(actor)
        const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: request.query.courseId })
        if (!course) return fail('LMS_COURSE_NOT_FOUND', 404)
        assertCanEnroll(actor, course)
        const enrollments = await manager.getRepository(LmsEnrollmentEntity).find({ where: { courseId: course.id, ...(!actor.operator ? { grantPlatformId: actor.platformId } : {}) }, order: { created: 'DESC' }, take: 100 })
        if (!enrollments.length) return []
        const identities = await manager.getRepository(UserIdentityEntity).find({ where: { id: In([...new Set(enrollments.map(row => row.identityId))]) }, select: { id: true, email: true } })
        const workspaceIds = [...new Set(enrollments.flatMap(row => row.workspacePlatformId ? [row.workspacePlatformId] : []))]
        const workspaces = workspaceIds.length ? await manager.getRepository(PlatformEntity).find({ where: { id: In(workspaceIds) }, select: { id: true, name: true } }) : []
        const training = hostingConfiguration.getServiceMode() === 'hosted' ? await manager.getRepository(HostingTrainingEntity).findBy({ enrollmentId: In(enrollments.map(row => row.id)) }) : []
        return enrollments.map(row => {
            const delivery = training.find(item => item.enrollmentId === row.id)
            return { ...row, learnerEmail: identities.find(identity => identity.id === row.identityId)?.email ?? null, workspaceName: workspaces.find(workspace => workspace.id === row.workspacePlatformId)?.name ?? null,
                training: delivery ? { activated: true, startsAt: delivery.startsAt.toISOString(), endsAt: delivery.endsAt.toISOString(), revoked: !!delivery.revokedAt } : null }
        })
    }))
    app.post('/operator/enrollments/:id/workspace', { config, schema: { params: enrollmentParams, body: z.strictObject({ workspacePlatformId: id, expectedWorkspacePlatformId: id.nullable() }) } }, async request => lmsTransaction(request, async (manager, actor) => {
        requireOperator(actor)
        if (hostingConfiguration.getServiceMode() !== 'hosted') fail('LMS_HOSTED_WORKSPACE_REQUIRED')
        return createLearningFulfillment({ dataSource: databaseConnection(), manager }).bindWorkspace({ actor, enrollmentId: request.params.id, ...request.body })
    }))
    app.post('/operator/enroll', { config, schema: { body: z.discriminatedUnion('accessType', [z.strictObject({ accessType: z.literal('learning'), identityId: id, courseId: id }), z.strictObject({ accessType: z.literal('partner_training'), identityId: id, courseId: id, package: z.enum(['core', 'launch']), paymentReference: z.string().trim().min(3).max(160), workspacePlatformId: id.optional(), paymentVerified: z.literal(true) })]) } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireManager(actor)
        const body = request.body
        const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: body.courseId, status: 'published' })
        if (!course) return fail('LMS_COURSE_NOT_PUBLISHED')
        assertCanEnroll(actor, course)
        const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: body.identityId, verified: true })
        if (!identity) fail('LMS_VERIFIED_IDENTITY_REQUIRED')
        const grantPlatformId = course.ownerPlatformId ?? (actor.operator ? null : actor.platformId)
        if (grantPlatformId) await assertOrdinaryRecipient(manager, body.identityId, grantPlatformId)
        if (body.accessType === 'partner_training') {
            requireOperator(actor)
            if (course.ownerPlatformId !== null || course.audience !== 'partner' || course.certificationMode !== 'partner') fail('LMS_PARTNER_TRAINING_REQUIRED')
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                if (!body.workspacePlatformId) return fail('LMS_WORKSPACE_REQUIRED')
                await assertLearningWorkspaceOwner(manager, body.identityId, body.workspacePlatformId)
            }
            const existing = await manager.getRepository(LmsEnrollmentEntity).findOneBy({ paymentReference: body.paymentReference })
            if (existing) {
                if (existing.accessType !== body.accessType || existing.identityId !== body.identityId || existing.courseId !== body.courseId || existing.package !== body.package || existing.workspacePlatformId !== (body.workspacePlatformId ?? null)) fail('LMS_PAYMENT_REFERENCE_CONFLICT', 409)
                return existing
            }
        }
        else if (course.audience !== 'end_user' || course.certificationMode !== 'none') fail('LMS_LEARNING_ACCESS_INVALID')
        if (await manager.getRepository(LmsEnrollmentEntity).existsBy({ identityId: body.identityId, courseId: course.id, grantPlatformId: grantPlatformId === null ? IsNull() : grantPlatformId })) fail('LMS_ALREADY_ENROLLED', 409)
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId: body.identityId, courseId: course.id, grantPlatformId, accessType: body.accessType, package: body.accessType === 'partner_training' ? body.package : null, paymentReference: body.accessType === 'partner_training' ? body.paymentReference : null, workspacePlatformId: body.accessType === 'partner_training' ? body.workspacePlatformId ?? null : null, startsAt: now, accessUntil: addDays(now, 365), assessmentUntil: addDays(now, body.accessType === 'partner_training' ? 90 : 365), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
        if (hostingConfiguration.getServiceMode() === 'hosted') await tx.event({ manager, platformId: grantPlatformId ?? actor.platformId, event: 'learning.course.enrolled', payload: { enrollmentId: enrollment.id, courseId: course.id, grantPlatformId, accessType: enrollment.accessType, actorIdentityId: actor.identityId, learnerIdentityId: enrollment.identityId } })
        return enrollment
    }))
    app.post('/operator/enrollments/:id/review', { config, schema: { params: enrollmentParams, body: z.object({ score: z.number().int().min(0).max(100), safety: safetySchema, feedback: z.string().trim().min(20).max(10000), walkthroughCompleted: z.literal(true) }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireOperator(actor)
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!enrollment || enrollment.status !== 'active' || enrollment.assessmentUntil <= now) return fail('LMS_ENROLLMENT_UNAVAILABLE')
        assertPartnerAssessment(enrollment, await courseForEnrollment(manager, enrollment))
        if (enrollment.identityId === actor.identityId) fail('LMS_INDEPENDENT_ASSESSOR_REQUIRED')
        const assignment = enrollment.assignment
        if (!assignment) return fail('LMS_PRACTICAL_SUBMISSION_REQUIRED')
        if (enrollment.practicalReviews.length >= 2 || enrollment.practicalReviews.at(-1)?.passed) fail('LMS_PRACTICAL_ATTEMPTS_EXHAUSTED')
        if ((enrollment.practicalReviews.at(-1)?.reviewedAt ?? '') >= assignment.submittedAt) fail('LMS_NEW_SUBMISSION_REQUIRED')
        const passed = request.body.score >= 80 && Object.values(request.body.safety).every(Boolean)
        enrollment.practicalReviews.push({ submission: assignment, score: request.body.score, safety: request.body.safety, feedback: request.body.feedback, assessorIdentityId: actor.identityId, reviewedAt: now.toISOString(), passed })
        await manager.getRepository(LmsEnrollmentEntity).save(enrollment)
        return { enrollment, certificate: null }
    }))
    app.post('/operator/enrollments/:id/certify', { config, schema: { params: enrollmentParams } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireOperator(actor)
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!enrollment) return fail('LMS_ENROLLMENT_NOT_FOUND', 404)
        return maybeCertificate(manager, enrollment, actor, now)
    }))
    app.post('/operator/enrollments/:id/revoke', { config, schema: { params: enrollmentParams } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireManager(actor)
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!enrollment) return fail('LMS_ENROLLMENT_NOT_FOUND', 404)
        const course = await courseForEnrollment(manager, enrollment)
        assertCanEnroll(actor, course)
        if (!actor.operator && enrollment.grantPlatformId !== actor.platformId) fail('LMS_ENROLLMENT_UNAVAILABLE')
        if (enrollment.accessType === 'partner_training' && hostingConfiguration.getServiceMode() === 'hosted') {
            await createLearningFulfillment({ dataSource: databaseConnection(), manager }).revoke({ actor, enrollmentId: enrollment.id })
        }
        else {
            enrollment.status = 'revoked'
            await manager.getRepository(LmsEnrollmentEntity).save(enrollment)
            await manager.getRepository(LmsCertificateEntity).update({ enrollmentId: enrollment.id, revokedAt: IsNull() }, { revokedAt: now })
        }
        return { revoked: true }
    }))
    app.post('/operator/enrollments/:id/certificate/revoke', { config, schema: { params: enrollmentParams } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireOperator(actor)
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOneBy({ id: request.params.id })
        if (!enrollment) return fail('LMS_ENROLLMENT_NOT_FOUND', 404)
        assertPartnerAssessment(enrollment, await courseForEnrollment(manager, enrollment))
        await manager.getRepository(LmsCertificateEntity).update({ enrollmentId: enrollment.id, revokedAt: IsNull() }, { revokedAt: now })
        return { revoked: true }
    }))
    app.get('/certificates/:token', { config: { security: securityAccess.public(), rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }) } }, async (request, reply) => {
        const manager = databaseConnection().manager
        const certificate = await manager.getRepository(LmsCertificateEntity).findOneBy({ verificationToken: request.params.token })
        if (!certificate) return reply.code(404).send({ code: 'LMS_CERTIFICATE_NOT_FOUND' })
        const [clock] = await manager.query('SELECT clock_timestamp() AS now')
        return { id: certificate.id, title: certificate.title, issuedAt: certificate.issuedAt, expiresAt: certificate.expiresAt, status: certificate.revokedAt ? 'revoked' : certificate.expiresAt <= new Date(clock.now) ? 'expired' : 'valid', issuer: 'Sydekyks', scope: 'Platform-specific credential; no external accreditation claimed.' }
    })
}
