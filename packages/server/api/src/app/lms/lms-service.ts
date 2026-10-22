import { randomBytes, randomInt } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { PlatformRole, PrincipalType, UserStatus } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { EntityManager, In } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { databaseConnection } from '../database/database-connection'
import { hasOperationalAccess, hostingOperatorIdentityIds, isOperationalUser } from '../hosting/hosting-access-policy'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { HostingAccountEntity } from '../hosting/hosting-entities'
import { assertTrainerClient, currentPlatformTrainer, isPrivilegedTrainerIdentity, listTrainerClients } from '../hosting/hosting-trainer-policy'
import { HostingActor } from '../hosting/hosting-transactions'
import { UserEntity } from '../user/user-entity'
import { LmsCertificate, LmsCertificateEntity, LmsCourse, LmsCourseEntity, LmsEnrollment, LmsEnrollmentEntity, LmsExamAttempt, LmsExamAttemptEntity } from './lms-entities'
import { courseContentSchema, Question } from './lms-schema'

export class LmsError extends Error {
    constructor(message: string, public readonly status = 403) {
        super(message) 
    }
}
export const fail = (message: string, status = 403): never => {
    throw new LmsError(message, status) 
}
export type LmsActor = HostingActor & { operator: boolean, tenantAdmin: boolean, ordinaryMember: boolean, trainer: boolean, trainerRecorded: boolean, trainerClientIds: string[] }
export async function lmsActor(manager: EntityManager, request: FastifyRequest): Promise<LmsActor> {
    if (request.principal.type !== PrincipalType.USER) return fail('LMS_USER_REQUIRED')
    const principal = request.principal
    const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id, status: UserStatus.ACTIVE })
    if (!user) return fail('LMS_ACCESS_DENIED')
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: user.identityId })
    if (!identity?.verified || principal.tokenVersion === undefined || (identity.tokenVersion ?? null) !== principal.tokenVersion) return fail('LMS_SESSION_EXPIRED')
    const operational = isOperationalUser(user)
    const operator = !operational && hostingOperatorIdentityIds().includes(identity.id) && user.platformRole === PlatformRole.ADMIN
    const trainerRecorded = !operator && await isPrivilegedTrainerIdentity(manager, identity.id)
    const actor = { identityId: identity.id, platformId: principal.platform.id, tokenVersion: principal.tokenVersion }
    const trainer = trainerRecorded ? await currentPlatformTrainer({ manager, actor, lock: true }) : null
    if (operational && !trainer && !await hasOperationalAccess({ manager, user })) return fail('LMS_ACCESS_DENIED')
    const ordinaryMember = !operational
    const partnerWorkspace = hostingConfiguration.getServiceMode() === 'hosted' && await manager.getRepository(HostingAccountEntity).existsBy({ id: principal.platform.id, planId: In(['training', 'assessment']) })
    const clientPartnerAdmin = operational && user.platformRole === PlatformRole.ADMIN && await manager.getRepository(HostingAccountEntity).existsBy({ id: principal.platform.id, planId: In(['starter', 'team', 'scale']) })
    const tenantAdmin = !partnerWorkspace && !trainerRecorded && (ordinaryMember || clientPartnerAdmin) && user.platformRole === PlatformRole.ADMIN && (hostingConfiguration.getServiceMode() !== 'hosted' || await manager.getRepository(HostingAccountEntity).existsBy({ id: principal.platform.id }))
    return { identityId: identity.id, platformId: principal.platform.id, tokenVersion: principal.tokenVersion, operator, tenantAdmin, ordinaryMember, trainer: !!trainer, trainerRecorded, trainerClientIds: trainer ? (await listTrainerClients({ manager, actor })).map(client => client.platformId) : [] }
}
export function requireManager(actor: LmsActor): void {
    if (!actor.operator && !actor.tenantAdmin && !actor.trainer) fail('LMS_INSTRUCTOR_REQUIRED')
}
export function assertCourseShape(course: Pick<LmsCourse, 'ownerPlatformId' | 'audience' | 'certificationMode'>): void {
    if ((course.ownerPlatformId !== null && (course.audience !== 'end_user' || course.certificationMode !== 'none')) || (course.certificationMode === 'partner' && (course.ownerPlatformId !== null || course.audience !== 'partner'))) fail('LMS_INVALID_COURSE_SCOPE', 400)
}
export function canManageCourse(actor: LmsActor, course: LmsCourse): boolean {
    return actor.operator || (actor.trainer ? course.ownerPlatformId !== null && actor.trainerClientIds.includes(course.ownerPlatformId) : actor.tenantAdmin && course.ownerPlatformId === actor.platformId)
}
export async function assertManageCourse(manager: EntityManager, actor: LmsActor, course: LmsCourse): Promise<void> {
    if (!canManageCourse(actor, course)) fail('LMS_COURSE_ACCESS_DENIED')
    if (actor.trainer && course.ownerPlatformId) await assertTrainerClient({ manager, actor, platformId: course.ownerPlatformId })
}
export async function assertCanEnroll(manager: EntityManager, actor: LmsActor, course: LmsCourse): Promise<void> {
    requireManager(actor)
    assertCourseShape(course)
    if (actor.trainer) {
        if (course.ownerPlatformId) await assertTrainerClient({ manager, actor, platformId: course.ownerPlatformId })
        else if (course.status !== 'published') fail('LMS_COURSE_ACCESS_DENIED')
        return
    }
    if (course.audience === 'partner') requireOperator(actor)
    else if (!actor.operator && course.ownerPlatformId !== null && course.ownerPlatformId !== actor.platformId) fail('LMS_COURSE_ACCESS_DENIED')
}
export async function assertOrdinaryRecipient(manager: EntityManager, identityId: string, platformId: string): Promise<void> {
    const user = await manager.getRepository(UserEntity).findOneBy({ identityId, platformId, status: UserStatus.ACTIVE })
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: identityId, verified: true })
    if (!user || isOperationalUser(user) || !identity) fail('LMS_ELIGIBLE_TENANT_MEMBER_REQUIRED')
}
export function assertEnrollmentShape(enrollment: LmsEnrollment, course: LmsCourse): void {
    assertCourseShape(course)
    if (course.ownerPlatformId !== null && enrollment.grantPlatformId !== course.ownerPlatformId) fail('LMS_ENROLLMENT_SCOPE_MISMATCH')
    if (enrollment.accessType === 'partner_training') {
        if (course.ownerPlatformId !== null || course.audience !== 'partner' || course.certificationMode !== 'partner' || enrollment.grantPlatformId !== null || !enrollment.package || !enrollment.paymentReference) fail('LMS_PARTNER_TRAINING_REQUIRED')
    }
    else {
        if (enrollment.package !== null || enrollment.paymentReference !== null || enrollment.workspacePlatformId !== null) fail('LMS_LEARNING_ACCESS_INVALID')
        if (enrollment.accessType === 'partner_course') {
            if (course.ownerPlatformId !== null || course.audience !== 'partner' || course.certificationMode !== 'partner' || enrollment.grantPlatformId !== null) fail('LMS_PARTNER_COURSE_REQUIRED')
        }
        else if (course.audience !== 'end_user' || course.certificationMode !== 'none') fail('LMS_LEARNING_ACCESS_INVALID')
    }
}
export function assertPartnerAssessment(enrollment: LmsEnrollment, course: LmsCourse): void {
    assertEnrollmentShape(enrollment, course)
    if (!['partner_training', 'partner_course'].includes(enrollment.accessType) || course.certificationMode !== 'partner') fail('LMS_ASSESSMENT_NOT_INCLUDED')
}
export function validatePublication(course: LmsCourse): void {
    assertCourseShape(course)
    courseContentSchema.parse(course.content)
    if (course.certificationMode === 'partner' && (course.content.lessons.length < 4 || course.content.questions.length < 60 || course.content.lessons.some(lesson => lesson.exercise.trim().length < 20))) fail('LMS_PARTNER_ASSESSMENT_CONTENT_REQUIRED', 400)
    if (course.certificationMode === 'none' && course.content.questions.length !== 0) fail('LMS_LESSON_ONLY_COURSE_HAS_NO_EXAM', 400)
}
export function learnerScope(actor: LmsActor, enrollment: LmsEnrollment): boolean {
    return enrollment.identityId === actor.identityId && (enrollment.grantPlatformId === null || (actor.ordinaryMember && enrollment.grantPlatformId === actor.platformId))
}
export async function lmsTransaction<T>(request: FastifyRequest, fn: (manager: EntityManager, actor: LmsActor, now: Date) => Promise<T>): Promise<T> {
    return databaseConnection().transaction(async manager => {
        const actor = await lmsActor(manager, request)
        const [clock] = await manager.query('SELECT clock_timestamp() AS now')
        return fn(manager, actor, new Date(clock.now))
    })
}
export function requireOperator(actor: LmsActor): void {
    if (!actor.operator) fail('LMS_OPERATOR_REQUIRED') 
}
export async function learnerEnrollment(manager: EntityManager, actor: LmsActor, now: Date, enrollmentId: string, assessment = false): Promise<LmsEnrollment> {
    const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: enrollmentId, identityId: actor.identityId }, lock: { mode: 'pessimistic_write' } })
    const [clock] = await manager.query('SELECT clock_timestamp() AS now')
    now.setTime(new Date(clock.now).getTime())
    if (!enrollment || !learnerScope(actor, enrollment) || enrollment.status !== 'active' || enrollment.startsAt > now || (assessment ? enrollment.assessmentUntil : enrollment.accessUntil) <= now) return fail('LMS_ENROLLMENT_UNAVAILABLE')
    const course = await courseForEnrollment(manager, enrollment)
    if (assessment) assertPartnerAssessment(enrollment, course)
    return enrollment
}
export function shuffle<T>(items: T[]): T[] {
    const values = [...items]
    for (let i = values.length - 1; i > 0; i--) {
        const j = randomInt(i + 1)
        ;[values[i], values[j]] = [values[j], values[i]]
    }
    return values
}
export function examQuestions(bank: Question[]): Question[] {
    return shuffle(bank).slice(0, 30).map(question => {
        const indices = shuffle([0, 1, 2, 3])
        return { ...question, options: indices.map(index => question.options[index]), correctIndex: indices.indexOf(question.correctIndex) }
    })
}
export function publicAttempt(attempt: LmsExamAttempt, now: Date): { id: string, ordinal: number, startedAt: Date, deadline: Date, serverNow: Date, submittedAt: Date | null, score: number | null, passed: boolean | null, answers: Record<string, number>, questions: Pick<Question, 'id' | 'prompt' | 'options'>[] } {
    return { id: attempt.id, ordinal: attempt.ordinal, startedAt: attempt.startedAt, deadline: attempt.deadline, serverNow: now, submittedAt: attempt.submittedAt, score: attempt.score, passed: attempt.passed, answers: attempt.answers, questions: attempt.questions.map(({ id, prompt, options }) => ({ id, prompt, options })) }
}
export function checkAnswers(attempt: LmsExamAttempt, answers: Record<string, number>): void {
    if (Object.keys(answers).some(id => !attempt.questions.some(question => question.id === id))) fail('LMS_INVALID_QUESTION', 400)
}
export async function finishExam(manager: EntityManager, attempt: LmsExamAttempt, now: Date): Promise<void> {
    if (attempt.submittedAt) return
    const correct = attempt.questions.filter(question => attempt.answers[question.id] === question.correctIndex).length
    attempt.score = Math.floor(correct / attempt.questions.length * 100)
    attempt.passed = attempt.score >= 80
    attempt.submittedAt = now
    await manager.getRepository(LmsExamAttemptEntity).save(attempt)
}
export async function expireAttempt(manager: EntityManager, attempt: LmsExamAttempt | null, now: Date): Promise<void> {
    if (attempt && !attempt.submittedAt && attempt.deadline <= now) await finishExam(manager, attempt, now)
}
export async function maybeCertificate(manager: EntityManager, enrollment: LmsEnrollment, actor: LmsActor, now: Date): Promise<LmsCertificate> {
    requireOperator(actor)
    assertPartnerAssessment(enrollment, await courseForEnrollment(manager, enrollment))
    if (actor.identityId === enrollment.identityId) fail('LMS_INDEPENDENT_ASSESSOR_REQUIRED')
    if (enrollment.status !== 'active') fail('LMS_ENROLLMENT_UNAVAILABLE')
    const practical = enrollment.practicalReviews.at(-1)
    const written = await manager.getRepository(LmsExamAttemptEntity).findOneBy({ enrollmentId: enrollment.id, passed: true })
    if (!written || !practical?.passed || practical.score < 80 || !Object.values(practical.safety).every(Boolean)) fail('LMS_BOTH_ASSESSMENTS_REQUIRED')
    const existing = await manager.getRepository(LmsCertificateEntity).findOneBy({ enrollmentId: enrollment.id })
    if (existing) return existing
    const expiresAt = new Date(now)
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1)
    return manager.getRepository(LmsCertificateEntity).save({ id: apId(), enrollmentId: enrollment.id, verificationToken: randomBytes(32).toString('base64url'), title: 'Sydekyks Certified AI Workflow Implementer', issuedAt: now, expiresAt, revokedAt: null, issuedBy: actor.identityId })
}
export async function courseForEnrollment(manager: EntityManager, enrollment: LmsEnrollment): Promise<LmsCourse> {
    const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: enrollment.courseId, status: 'published' })
    if (!course) return fail('LMS_COURSE_NOT_PUBLISHED')
    assertEnrollmentShape(enrollment, course)
    return course
}
