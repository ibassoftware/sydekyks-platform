import { randomBytes, randomInt } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { PlatformRole, PrincipalType, UserStatus } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { EntityManager } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { databaseConnection } from '../database/database-connection'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { UserEntity } from '../user/user-entity'
import { LmsCertificate, LmsCertificateEntity, LmsCourse, LmsCourseEntity, LmsEnrollment, LmsEnrollmentEntity, LmsExamAttempt, LmsExamAttemptEntity } from './lms-entities'
import { Question } from './lms-schema'

export class LmsError extends Error {
    constructor(message: string, public readonly status = 403) {
        super(message) 
    }
}
export const fail = (message: string, status = 403): never => {
    throw new LmsError(message, status) 
}
export type LmsActor = { identityId: string, operator: boolean }
export async function lmsActor(manager: EntityManager, request: FastifyRequest): Promise<LmsActor> {
    if (request.principal.type !== PrincipalType.USER) return fail('LMS_USER_REQUIRED')
    const principal = request.principal
    const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id, status: UserStatus.ACTIVE })
    if (!user) return fail('LMS_ACCESS_DENIED')
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: user.identityId })
    if (!identity?.verified || (identity.tokenVersion ?? null) !== (principal.tokenVersion ?? null)) return fail('LMS_SESSION_EXPIRED')
    const allowed = (system.get(AppSystemProp.HOSTED_OPERATOR_IDENTITY_IDS) ?? '').split(',').map(value => value.trim()).filter(value => /^[a-zA-Z0-9_-]{21}$/.test(value))
    return { identityId: identity.id, operator: allowed.includes(identity.id) && user.platformRole === PlatformRole.ADMIN }
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
export async function learnerEnrollment(manager: EntityManager, actor: LmsActor, now: Date, assessment = false): Promise<LmsEnrollment> {
    const enrollment = await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { identityId: actor.identityId }, order: { created: 'DESC' }, lock: { mode: 'pessimistic_write' } })
    const [clock] = await manager.query('SELECT clock_timestamp() AS now')
    now.setTime(new Date(clock.now).getTime())
    if (!enrollment || enrollment.status !== 'active' || enrollment.startsAt > now || (assessment ? enrollment.assessmentUntil : enrollment.accessUntil) <= now) return fail('LMS_ENROLLMENT_UNAVAILABLE')
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
    return course
}
