import { enrollClientDefaultCourses } from '../lms/lms-client-defaults'
import { createHmac } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { hostingCatalog, UserIdentityProvider } from '@activepieces/shared'
import { DataSource, EntityManager, IsNull } from 'typeorm'
import { passwordHasher } from '../authentication/lib/password-hasher'
import { signupNames } from '../authentication/lib/signup-names'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../lms/lms-entities'
import { PlatformEntity } from '../platform/platform.entity'
import { createHostedAccess } from './hosting-access'
import { assertHostingOperator } from './hosting-access-policy'
import { hostingConfiguration } from './hosting-configuration'
import { createHostedCreditAllowance, effectiveHostedCredits } from './hosting-credit-allowance'
import { HostingCreditAllowanceBindingEntity } from './hosting-credit-allowance-entities'
import { HostingAccount, HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity } from './hosting-entities'
import { HostingManualAccountEntity, HostingManualCommandEntity, HostingManualTerm, HostingManualTermEntity } from './hosting-manual-accounts-entities'
import { HostingManualAccountCreate, HostingManualEnrollmentCreate, HostingManualTermCreate } from './hosting-manual-accounts-schema'
import { currentManualTerm, manualTermPeriods, manualTermSource } from './hosting-manual-terms'
import { createHostedOnboarding } from './hosting-onboarding'
import { HostingPartnerPurchaseEntity } from './hosting-partner-billing-entities'
import { HostingStripeBindingEntity } from './hosting-stripe-entities'
import { HostingSubscriptionCommandEntity, HostingSubscriptionEntity } from './hosting-subscription-entities'
import { lastFundedSubscriptionPeriod, loadSubscriptionContext, subscriptionAccountActive, subscriptionAccountUntil } from './hosting-subscription-policy'
import { HostingTrainingEntity } from './hosting-training-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export function createHostedManualAccounts({ dataSource, subjectSecret }: { dataSource: DataSource, subjectSecret: string }) {
    if (hostingConfiguration.getServiceMode() !== 'hosted') hostingFail('HOSTED_INSTALLATION_REQUIRED')
    if (subjectSecret.length < 32) hostingFail('HOSTING_SUBJECT_SECRET_REQUIRED')
    const digest = (value: unknown): string => createHmac('sha256', subjectSecret).update(`manual-account:v1:${canonical(value)}`).digest('hex')
    async function operatorLock(manager: EntityManager, actor: HostingActor) {
        await manager.getRepository(UserIdentityEntity).findOne({ where: { id: actor.identityId }, lock: { mode: 'pessimistic_write' } })
        return assertHostingOperator({ manager, actor })
    }
    async function read({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            const user = await assertHostingOperator({ manager, actor })
            const account = await tx.account({ manager, platformId })
            return { platformId: actor.platformId, userId: user.id, account: await view(manager, account), replayed: false }
        } })
    }
    async function create({ actor, input }: { actor: HostingActor, input: HostingManualAccountCreate }) {
        const value = HostingManualAccountCreate.parse(input), payloadHash = digest({ action: 'create', input: value })
        // Check operator authority before expensive hashing. The transaction
        // repeats it under the actor lock before any identity/credit write.
        await tx.run({ dataSource, fn: async manager => assertHostingOperator({ manager, actor }) })
        const password = await passwordHasher.hash(value.password)
        try {
            return await tx.run({ dataSource, fn: async manager => {
                const user = await operatorLock(manager, actor)
                const previous = await manager.getRepository(HostingManualCommandEntity).findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
                if (previous) {
                    if (previous.action !== 'create' || previous.payloadHash !== payloadHash) hostingFail('HOSTING_MANUAL_IDEMPOTENCY_CONFLICT')
                    return { platformId: actor.platformId, userId: user.id, account: await view(manager, await tx.account({ manager, platformId: previous.platformId })), replayed: true }
                }
                const existing = await manager.getRepository(UserIdentityEntity).createQueryBuilder('identity').where('LOWER(identity.email) = :email', { email: value.email }).getOne()
                if (existing) hostingFail('HOSTING_MANUAL_EMAIL_EXISTS')
                const names = signupNames.splitFullName({ fullName: value.fullName, email: value.email }), identityId = apId()
                await manager.getRepository(UserIdentityEntity).save({ id: identityId, email: value.email, ...names, password, provider: UserIdentityProvider.EMAIL, verified: true, tokenVersion: apId(), trackEvents: false, newsLetter: false })
                const workspace = await createHostedOnboarding({ dataSource, subjectSecret }).provision({ identityId, name: value.companyName, operator: actor, manager })
                const account = await tx.account({ manager, platformId: workspace.platformId }), startsAt = await tx.now(manager)
                const term = await issueTerm(manager, { platformId: account.id, identityId, planId: value.planId, revision: 1, startsAt, expiresAt: new Date(value.expiresAt), monthlyCredits: value.monthlyCredits ?? hostingCatalog.getPlan({ planId: value.planId }).executions, operatorIdentityId: actor.identityId, reason: value.reason })
                let enrollmentId: string | null = null
                if (value.kind === 'partner' && value.partner.courseId) {
                    const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: value.partner.courseId, status: 'published', ownerPlatformId: IsNull(), audience: 'partner', certificationMode: 'partner' })
                    if (!course) hostingFail('HOSTING_MANUAL_PARTNER_COURSE_REQUIRED')
                    const enrollment = await manager.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId, courseId: course.id, grantPlatformId: null, accessType: 'partner_training', package: value.partner.package, paymentReference: `manual-term:${term.id}`, workspacePlatformId: account.id, startsAt, accessUntil: term.expiresAt, assessmentUntil: new Date(Math.min(term.expiresAt.getTime(), startsAt.getTime() + 90 * 86400_000)), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
                    enrollmentId = enrollment.id
                }
                await manager.getRepository(HostingManualAccountEntity).save({ id: account.id, identityId, kind: value.kind, package: value.kind === 'partner' ? value.partner.package : null, enrollmentId, termId: term.id, revision: 1 })
                await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { planId: value.planId, status: 'active', validUntil: term.expiresAt, catalogVersion: hostingCatalog.version })
                if (value.kind === 'client') await enrollClientDefaultCourses(manager, { platformId: account.id, identityId, enrolledBy: actor.identityId, now: startsAt })
                if (value.kind === 'partner' && value.partner.approve) await createHostedAccess({ dataSource, manager }).setRole({ actor, identityId, role: 'partner', active: true })
                const result = await view(manager, await tx.account({ manager, platformId: account.id }))
                await manager.getRepository(HostingManualCommandEntity).save({ id: apId(), operatorIdentityId: actor.identityId, requestKey: value.requestKey, payloadHash, action: 'create', platformId: account.id, termId: term.id, snapshot: { ...result, method: 'operator', emailOwnershipVerified: false, partnerApproved: value.kind === 'partner' && value.partner.approve } })
                await tx.event({ manager, platformId: account.id, event: 'manual.account.created', payload: { operatorIdentityId: actor.identityId, identityId, termId: term.id, kind: value.kind, planId: value.planId, enrollmentId, method: 'operator', emailOwnershipVerified: false } })
                return { platformId: actor.platformId, userId: user.id, account: result, replayed: false }
            } })
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') hostingFail('HOSTING_MANUAL_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    async function renew({ actor, platformId, input }: { actor: HostingActor, platformId: string, input: HostingManualTermCreate }) {
        const value = HostingManualTermCreate.parse(input), payloadHash = digest({ action: 'renew', platformId, input: value })
        return tx.run({ dataSource, fn: async manager => {
            const user = await operatorLock(manager, actor)
            const peek = await manager.getRepository(HostingManualAccountEntity).findOneBy({ id: platformId })
            if (!peek) hostingFail('HOSTING_MANUAL_ACCOUNT_REQUIRED')
            // Match LMS revocation: enrollment -> account after the actor lock.
            const enrollment = peek.enrollmentId ? await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: peek.enrollmentId }, lock: { mode: 'pessimistic_write' } }) : null
            const account = await tx.account({ manager, platformId })
            const previous = await manager.getRepository(HostingManualCommandEntity).findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
            if (previous) {
                if (previous.action !== 'renew' || previous.platformId !== platformId || previous.payloadHash !== payloadHash) hostingFail('HOSTING_MANUAL_IDEMPOTENCY_CONFLICT')
                return { platformId: actor.platformId, userId: user.id, account: await view(manager, account), replayed: true }
            }
            const bound = await manager.getRepository(HostingManualAccountEntity).findOneByOrFail({ id: platformId })
            const prior = await currentManualTerm(manager, account), startsAt = await tx.now(manager)
            if (!prior || bound.revision !== value.expectedRevision || bound.revision >= 1000) hostingFail('HOSTING_MANUAL_REVISION_CONFLICT')
            if (prior.expiresAt > startsAt) hostingFail('HOSTING_MANUAL_ACTIVE_TERM_REQUIRES_REVIEW')
            if (account.status === 'suspended' || account.billingHold || await manager.getRepository(HostingStripeBindingEntity).existsBy({ platformId }) || await manager.getRepository(HostingPartnerPurchaseEntity).existsBy({ platformId }) || await manager.getRepository(HostingTrainingEntity).existsBy({ platformId })) hostingFail('HOSTING_MANUAL_FUNDING_REQUIRES_REVIEW')
            if (bound.enrollmentId && (!enrollment || enrollment.status !== 'active' || enrollment.identityId !== account.ownerIdentityId || enrollment.workspacePlatformId !== platformId)) hostingFail('HOSTING_MANUAL_ENROLLMENT_REQUIRES_REVIEW')
            const revision = bound.revision + 1
            const term = await issueTerm(manager, { platformId, identityId: account.ownerIdentityId, planId: prior.planId, revision, startsAt, expiresAt: new Date(value.expiresAt), monthlyCredits: value.monthlyCredits ?? await effectiveHostedCredits(manager, platformId, prior.planId), operatorIdentityId: actor.identityId, reason: value.reason })
            await manager.getRepository(HostingManualAccountEntity).update({ id: platformId }, { termId: term.id, revision })
            await manager.getRepository(HostingAccountEntity).update({ id: platformId }, { validUntil: term.expiresAt })
            if (enrollment) await manager.getRepository(LmsEnrollmentEntity).update({ id: enrollment.id }, { accessUntil: term.expiresAt })
            const renewed = await tx.account({ manager, platformId })
            // An old explicit due-date override cannot silently bind new funding.
            // This explicit funding command records its replacement due date.
            const override = await manager.getRepository(HostingSubscriptionEntity).findOneBy({ id: platformId })
            if (override) {
                const binding = await lastFundedSubscriptionPeriod(manager, renewed)
                if (!binding) hostingFail('HOSTING_MANUAL_FUNDING_SOURCE_INVALID')
                const subscription = { ...binding, id: platformId, revision: override.revision + 1, renewalDueAt: term.expiresAt }
                await manager.getRepository(HostingSubscriptionEntity).save(subscription)
                await manager.getRepository(HostingSubscriptionCommandEntity).save({ id: apId(), platformId, actorIdentityId: actor.identityId, requestKey: `manual-term:${term.id}`, payloadHash, revision: subscription.revision, reason: value.reason, snapshot: { planId: term.planId, entitlementId: term.id, renewalDueAt: term.expiresAt.toISOString(), sourceKey: binding.sourceKey, manualTermId: term.id } })
            }
            const allowance = await manager.getRepository(HostingCreditAllowanceBindingEntity).findOneBy({ platformId })
            if (allowance && await effectiveHostedCredits(manager, platformId, term.planId) !== term.monthlyCredits) {
                // Reuse the audited allowance command in this transaction. Old
                // expired grants and held liabilities are outside its eligible set.
                await createHostedCreditAllowance({ dataSource, manager }).save({ actor, input: { platformId, expectedRevision: allowance.revision, requestKey: `manual-term:${term.id}`, monthlyCredits: term.monthlyCredits, reason: value.reason } })
            }
            const result = await view(manager, await tx.account({ manager, platformId }))
            await manager.getRepository(HostingManualCommandEntity).save({ id: apId(), operatorIdentityId: actor.identityId, requestKey: value.requestKey, payloadHash, action: 'renew', platformId, termId: term.id, snapshot: result })
            await tx.event({ manager, platformId, event: 'manual.term.renewed', payload: { operatorIdentityId: actor.identityId, termId: term.id, previousTermId: prior.id, revision, expiresAt: term.expiresAt.toISOString(), monthlyCredits: term.monthlyCredits } })
            return { platformId: actor.platformId, userId: user.id, account: result, replayed: false }
        } })
    }
    async function enroll({ actor, platformId, input }: { actor: HostingActor, platformId: string, input: HostingManualEnrollmentCreate }) {
        const value = HostingManualEnrollmentCreate.parse(input), payloadHash = digest({ action: 'enroll', platformId, input: value })
        return tx.run({ dataSource, fn: async manager => {
            const user = await operatorLock(manager, actor)
            const peek = await manager.getRepository(HostingManualAccountEntity).findOneBy({ id: platformId })
            if (!peek) hostingFail('HOSTING_MANUAL_ACCOUNT_NOT_FOUND')
            const existing = peek.enrollmentId ? await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: peek.enrollmentId }, lock: { mode: 'pessimistic_write' } }) : null
            const account = await tx.account({ manager, platformId })
            const bound = await manager.getRepository(HostingManualAccountEntity).findOneByOrFail({ id: platformId })
            // A concurrent first assignment must retry with enrollment -> account
            // lock order rather than locking a newly discovered row backwards.
            if (bound.enrollmentId !== peek.enrollmentId) hostingFail('HOSTING_MANUAL_REVISION_CONFLICT')
            const previous = await manager.getRepository(HostingManualCommandEntity).findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
            if (previous) {
                if (previous.action !== 'enroll' || previous.platformId !== platformId || previous.payloadHash !== payloadHash) hostingFail('HOSTING_MANUAL_IDEMPOTENCY_CONFLICT')
                return { platformId: actor.platformId, userId: user.id, account: await view(manager, account), replayed: true }
            }
            const term = await currentManualTerm(manager, account), now = await tx.now(manager)
            if (bound.revision !== value.expectedRevision) hostingFail('HOSTING_MANUAL_REVISION_CONFLICT')
            if (bound.kind !== 'partner' || !bound.package || !term || term.planId !== 'training') hostingFail('HOSTING_MANUAL_PARTNER_ACCOUNT_REQUIRED')
            if (existing) {
                if (existing.courseId !== value.courseId || existing.status !== 'active' || existing.identityId !== bound.identityId || existing.workspacePlatformId !== platformId) hostingFail('HOSTING_MANUAL_ENROLLMENT_CONFLICT')
                return { platformId: actor.platformId, userId: user.id, account: await view(manager, account), replayed: true }
            }
            if (term.expiresAt <= now || !subscriptionAccountActive(account, now)) hostingFail('HOSTING_MANUAL_ACTIVE_TERM_REQUIRED')
            const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: value.courseId, status: 'published', ownerPlatformId: IsNull(), audience: 'partner', certificationMode: 'partner' })
            if (!course) hostingFail('HOSTING_MANUAL_PARTNER_COURSE_REQUIRED')
            if (await manager.getRepository(LmsEnrollmentEntity).existsBy({ identityId: bound.identityId, courseId: course.id, grantPlatformId: IsNull() })) hostingFail('HOSTING_MANUAL_ENROLLMENT_CONFLICT')
            const cutoff = subscriptionAccountUntil(account), accessUntil = cutoff < term.expiresAt ? cutoff : term.expiresAt
            const enrollment = await manager.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId: bound.identityId, courseId: course.id, grantPlatformId: null, accessType: 'partner_training', package: bound.package, paymentReference: `manual-term:${term.id}`, workspacePlatformId: platformId, startsAt: now, accessUntil, assessmentUntil: new Date(Math.min(accessUntil.getTime(), now.getTime() + 90 * 86400_000)), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
            await manager.getRepository(HostingManualAccountEntity).update({ id: platformId }, { enrollmentId: enrollment.id })
            const result = await view(manager, account)
            await manager.getRepository(HostingManualCommandEntity).save({ id: apId(), operatorIdentityId: actor.identityId, requestKey: value.requestKey, payloadHash, action: 'enroll', platformId, termId: term.id, snapshot: { ...result, courseId: course.id } })
            await tx.event({ manager, platformId, event: 'manual.course.assigned', payload: { operatorIdentityId: actor.identityId, identityId: bound.identityId, termId: term.id, courseId: course.id, enrollmentId: enrollment.id, method: 'operator', emailOwnershipVerified: false } })
            return { platformId: actor.platformId, userId: user.id, account: result, replayed: false }
        } })
    }
    return { read, create, renew, enroll }
}
async function issueTerm(manager: EntityManager, input: Omit<HostingManualTerm, 'id' | 'created' | 'updated'>) {
    const periods = manualTermPeriods(input)
    const term = await manager.getRepository(HostingManualTermEntity).save({ id: apId(), ...input })
    for (let period = 0; period < periods.length; period++) {
        for (const [meter, amount] of [['execution', BigInt(term.monthlyCredits)], ['managed_ai', 0n]] as const) {
            const id = apId()
            await manager.getRepository(HostingGrantEntity).insert({ id, platformId: term.platformId, sourceKey: manualTermSource(term, period), meter, amount, consumed: 0n, reserved: 0n, validFrom: periods[period].from, validUntil: periods[period].until })
            await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: term.platformId, grantId: id, reservationId: null, operation: 'grant', key: `grant:${id}`, amount })
        }
    }
    return term
}
async function view(manager: EntityManager, account: HostingAccount) {
    const bound = await manager.getRepository(HostingManualAccountEntity).findOneBy({ id: account.id, identityId: account.ownerIdentityId })
    const term = await currentManualTerm(manager, account)
    if (!bound) hostingFail('HOSTING_MANUAL_ACCOUNT_NOT_FOUND')
    if (!term) hostingFail('HOSTING_MANUAL_FUNDING_SOURCE_INVALID')
    const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: bound.identityId })
    const platform = await manager.getRepository(PlatformEntity).findOneByOrFail({ id: account.id })
    const context = await loadSubscriptionContext(manager, account)
    return { identityId: bound.identityId, platformId: account.id, name: platform.name, email: identity.email, fullName: `${identity.firstName} ${identity.lastName}`.trim(), planId: term.planId, kind: bound.kind, package: bound.package, termId: term.id, revision: bound.revision, startsAt: term.startsAt.toISOString(), expiresAt: term.expiresAt.toISOString(), graceEndsAt: subscriptionAccountUntil({ ...account, subscription: context }).toISOString(), monthlyCredits: await effectiveHostedCredits(manager, account.id, term.planId), fundedMonthlyCredits: term.monthlyCredits, seats: hostingCatalog.getPlan({ planId: term.planId }).users, enrollmentId: bound.enrollmentId, method: 'operator' as const, emailOwnershipVerified: false as const }
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
