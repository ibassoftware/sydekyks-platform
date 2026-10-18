import { ActivepiecesError, apId } from '@activepieces/core-utils'
import { PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { In, IsNull } from 'typeorm'
import { z } from 'zod'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { databaseConnection } from '../database/database-connection'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { assertLearningWorkspaceOwner, createLearningFulfillment } from '../hosting/hosting-learning-fulfillment'
import { HostingTrainingEntity } from '../hosting/hosting-training-entity'
import { HostingError } from '../hosting/hosting-transactions'
import { PlatformEntity } from '../platform/platform.entity'
import { foundingCourseDraft } from './lms-content'
import { LmsCertificateEntity, LmsCourseEntity, LmsEnrollmentEntity, LmsExamAttemptEntity } from './lms-entities'
import { courseContentSchema, safetySchema } from './lms-schema'
import { checkAnswers, courseForEnrollment, examQuestions, expireAttempt, fail, finishExam, learnerEnrollment, LmsError, lmsTransaction, maybeCertificate, publicAttempt, requireOperator } from './lms-service'

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
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { identityId: actor.identityId }, order: { created: 'DESC' } })
        if (!enrollment || enrollment.status !== 'active' || enrollment.startsAt > now || enrollment.accessUntil <= now) return { operator: actor.operator, enrollment: null, course: null, certificate: null, attempts: [] }
        const course = await courseForEnrollment(manager, enrollment)
        const attempts = await manager.getRepository(LmsExamAttemptEntity).find({ where: { enrollmentId: enrollment.id }, order: { ordinal: 'ASC' } })
        return { operator: actor.operator, enrollment, course: { id: course.id, revision: course.revision, title: course.content.title, description: course.content.description, lessons: course.content.lessons }, certificate: await manager.getRepository(LmsCertificateEntity).findOneBy({ enrollmentId: enrollment.id }), attempts: attempts.map(attempt => ({ id: attempt.id, ordinal: attempt.ordinal, deadline: attempt.deadline, score: attempt.score, passed: attempt.passed, submittedAt: attempt.submittedAt })) }
    }))
    app.post('/progress', { config, schema: { body: z.object({ lessonId: z.string().max(80), completed: z.boolean() }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now)
        const course = await courseForEnrollment(manager, enrollment)
        if (!course.content.lessons.some(lesson => lesson.id === request.body.lessonId)) fail('LMS_LESSON_NOT_FOUND', 404)
        enrollment.completedLessons = request.body.completed ? [...new Set([...enrollment.completedLessons, request.body.lessonId])] : enrollment.completedLessons.filter(value => value !== request.body.lessonId)
        await manager.getRepository(LmsEnrollmentEntity).save(enrollment)
        return { completedLessons: enrollment.completedLessons }
    }))
    app.post('/assignment', { config, schema: { body: z.object({ submission: z.string().trim().min(100).max(30000) }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, true)
        if (enrollment.practicalReviews.at(-1)?.passed || enrollment.practicalReviews.length >= 2) fail('LMS_PRACTICAL_ATTEMPTS_EXHAUSTED')
        if (enrollment.assignment && (!enrollment.practicalReviews.at(-1) || (enrollment.practicalReviews.at(-1)?.reviewedAt ?? '') < enrollment.assignment.submittedAt)) fail('LMS_PRACTICAL_AWAITING_REVIEW')
        enrollment.assignment = { submission: request.body.submission, submittedAt: now.toISOString() }
        await manager.getRepository(LmsEnrollmentEntity).save(enrollment)
        return enrollment.assignment
    }))
    app.post('/exam/start', { config }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now, true)
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
    app.get('/exam/current', { config }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now)
        const attempt = await manager.getRepository(LmsExamAttemptEntity).findOne({ where: { enrollmentId: enrollment.id }, order: { ordinal: 'DESC' } })
        await expireAttempt(manager, attempt, now)
        return attempt ? publicAttempt(attempt, now) : null
    }))
    for (const action of ['save', 'submit'] as const) app.post(`/exam/${action}`, { config, schema: { body: z.object({ attemptId: id, answers: answersSchema }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        const enrollment = await learnerEnrollment(manager, actor, now)
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
    app.get('/operator/course', { config }, async request => lmsTransaction(request, async (manager, actor) => {
        requireOperator(actor)
        return manager.getRepository(LmsCourseEntity).findOneBy({ slug: 'ai-workflow-implementer' })
    }))
    app.post('/operator/course/initialize', { config }, async request => lmsTransaction(request, async (manager, actor) => {
        requireOperator(actor)
        const repo = manager.getRepository(LmsCourseEntity)
        const existing = await repo.findOneBy({ slug: 'ai-workflow-implementer' })
        if (existing) return existing
        return repo.save({ id: apId(), slug: 'ai-workflow-implementer', revision: 1, status: 'draft', content: foundingCourseDraft, reviewedBy: null, reviewedAt: null })
    }))
    app.put('/operator/course/:id', { config, schema: { params: enrollmentParams, body: courseContentSchema } }, async request => lmsTransaction(request, async (manager, actor) => {
        requireOperator(actor)
        const course = await manager.getRepository(LmsCourseEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!course) return fail('LMS_COURSE_NOT_FOUND', 404)
        if (course.status !== 'draft') fail('LMS_PUBLISHED_COURSE_IS_IMMUTABLE')
        course.content = request.body
        course.revision += 1
        return manager.getRepository(LmsCourseEntity).save(course)
    }))
    app.post('/operator/course/:id/publish', { config, schema: { params: enrollmentParams, body: z.object({ revision: z.number().int().positive(), reviewedLessonsAndQuestions: z.literal(true) }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireOperator(actor)
        const course = await manager.getRepository(LmsCourseEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!course) return fail('LMS_COURSE_NOT_FOUND', 404)
        if (request.body.revision !== course.revision) fail('LMS_COURSE_CHANGED_REVIEW_AGAIN', 409)
        courseContentSchema.parse(course.content)
        course.status = 'published'
        course.reviewedBy = actor.identityId
        course.reviewedAt = now
        return manager.getRepository(LmsCourseEntity).save(course)
    }))
    app.get('/operator/enrollments', { config }, async request => lmsTransaction(request, async (manager, actor) => {
        requireOperator(actor)
        const enrollments = await manager.getRepository(LmsEnrollmentEntity).find({ order: { created: 'DESC' }, take: 100 })
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
    app.post('/operator/enroll', { config, schema: { body: z.object({ identityId: id, courseId: id, package: z.enum(['core', 'launch']), paymentReference: z.string().trim().min(3).max(160), workspacePlatformId: id.optional(), paymentVerified: z.literal(true) }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireOperator(actor)
        const body = request.body
        const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: body.courseId, status: 'published' })
        if (!course) return fail('LMS_COURSE_NOT_PUBLISHED')
        const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: body.identityId, verified: true })
        if (!identity) fail('LMS_VERIFIED_IDENTITY_REQUIRED')
        if (hostingConfiguration.getServiceMode() === 'hosted') {
            if (!body.workspacePlatformId) return fail('LMS_WORKSPACE_REQUIRED')
            await assertLearningWorkspaceOwner(manager, body.identityId, body.workspacePlatformId)
        }
        if (body.workspacePlatformId && !await manager.getRepository(PlatformEntity).existsBy({ id: body.workspacePlatformId })) fail('LMS_WORKSPACE_NOT_FOUND', 404)
        const existing = await manager.getRepository(LmsEnrollmentEntity).findOneBy({ paymentReference: body.paymentReference })
        if (existing) {
            if (existing.identityId !== body.identityId || existing.courseId !== body.courseId || existing.package !== body.package || existing.workspacePlatformId !== (body.workspacePlatformId ?? null)) fail('LMS_PAYMENT_REFERENCE_CONFLICT', 409)
            return existing
        }
        if (await manager.getRepository(LmsEnrollmentEntity).existsBy({ identityId: body.identityId, courseId: body.courseId })) fail('LMS_ALREADY_ENROLLED', 409)
        return manager.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId: body.identityId, courseId: body.courseId, package: body.package, paymentReference: body.paymentReference, workspacePlatformId: body.workspacePlatformId ?? null, startsAt: now, accessUntil: addDays(now, 365), assessmentUntil: addDays(now, 90), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
    }))
    app.post('/operator/enrollments/:id/review', { config, schema: { params: enrollmentParams, body: z.object({ score: z.number().int().min(0).max(100), safety: safetySchema, feedback: z.string().trim().min(20).max(10000), walkthroughCompleted: z.literal(true) }).strict() } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireOperator(actor)
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!enrollment || enrollment.status !== 'active' || enrollment.assessmentUntil <= now) return fail('LMS_ENROLLMENT_UNAVAILABLE')
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
        requireOperator(actor)
        if (hostingConfiguration.getServiceMode() === 'hosted') {
            await createLearningFulfillment({ dataSource: databaseConnection(), manager }).revoke({ actor, enrollmentId: request.params.id })
            return { revoked: true }
        }
        const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: request.params.id }, lock: { mode: 'pessimistic_write' } })
        if (!enrollment) return fail('LMS_ENROLLMENT_NOT_FOUND', 404)
        enrollment.status = 'revoked'
        await manager.getRepository(LmsEnrollmentEntity).save(enrollment)
        await manager.getRepository(LmsCertificateEntity).update({ enrollmentId: enrollment.id, revokedAt: IsNull() }, { revokedAt: now })
        return { revoked: true }
    }))
    app.post('/operator/certificates/:id/revoke', { config, schema: { params: enrollmentParams } }, async request => lmsTransaction(request, async (manager, actor, now) => {
        requireOperator(actor)
        await manager.getRepository(LmsCertificateEntity).update({ id: request.params.id, revokedAt: IsNull() }, { revokedAt: now })
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
