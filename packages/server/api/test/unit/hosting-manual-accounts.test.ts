import { apId } from '@activepieces/core-utils'
import { hostingCatalog, PlatformRole } from '@activepieces/shared'
import { DataSource, Like } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { passwordHasher } from '../../src/app/authentication/lib/password-hasher'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { createHostedBillingView } from '../../src/app/hosting/hosting-billing-view'
import { createHostedCreditAllowance, effectiveHostedCredits } from '../../src/app/hosting/hosting-credit-allowance'
import { HostingCreditAllowanceChangeEntity } from '../../src/app/hosting/hosting-credit-allowance-entities'
import { HostingAccountEntity, HostingGrantEntity, HostingInvitationEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { identityAdmission } from '../../src/app/hosting/hosting-identity-admission'
import { HostingRootCreditUsageEntity } from '../../src/app/hosting/hosting-inclusive-credits-entity'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedManualAccounts } from '../../src/app/hosting/hosting-manual-accounts'
import { HostingManualAccountEntity, HostingManualCommandEntity, HostingManualTermEntity } from '../../src/app/hosting/hosting-manual-accounts-entities'
import { HostingManualAccountCreate } from '../../src/app/hosting/hosting-manual-accounts-schema'
import { manualEnrollmentDelivery, manualTermPeriods } from '../../src/app/hosting/hosting-manual-terms'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPartnerAdmin } from '../../src/app/hosting/hosting-partner-admin'
import { createHostedPartnerBilling } from '../../src/app/hosting/hosting-partner-billing'
import { PartnerStripePolicy } from '../../src/app/hosting/hosting-partner-billing-adapter'
import { HostingPartnerPurchaseEntity } from '../../src/app/hosting/hosting-partner-billing-entities'
import { createHostedStripe } from '../../src/app/hosting/hosting-stripe'
import { HostingStripeBindingEntity, HostingStripePeriodEntity } from '../../src/app/hosting/hosting-stripe-entities'
import { createHostedSubscriptions } from '../../src/app/hosting/hosting-subscriptions'
import { HostingTrainingEntity } from '../../src/app/hosting/hosting-training-entity'
import { hostingMonthAnniversary } from '../../src/app/hosting/hosting-training-periods'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../src/app/lms/lms-content'
import { LmsCertificateEntity, LmsCourseEntity, LmsEnrollmentEntity, LmsExamAttemptEntity } from '../../src/app/lms/lms-entities'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const remote = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../src/app/hosting/hosting-stripe-adapter', () => ({ createStripeAdapter: async () => remote }))
const secret = 'synthetic-manual-account-subject-secret-at-least32characters'
const initialPassword = 'SyntheticManualPass123!'
let ds: DataSource, actor: HostingActor, other: HostingActor
const manual = () => createHostedManualAccounts({ dataSource: ds, subjectSecret: secret })
async function identity(email = `${apId()}@test.invalid`) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email, verified: true, provider: 'EMAIL', password: 'synthetic-unused', firstName: 'Manual', lastName: 'Test', tokenVersion: 'initial' })
    return id
}
function input(overrides: Record<string, unknown> = {}): HostingManualAccountCreate {
    return { requestKey: apId(), companyName: 'Synthetic Manual Company', fullName: 'Synthetic Learner', email: `${apId()}@test.invalid`, password: initialPassword, kind: 'client', planId: 'starter', expiresAt: new Date(Date.now() + 70 * 86400_000).toISOString(), reason: 'Synthetic operator confirmed manual funding', ...overrides } as HostingManualAccountCreate
}
async function created(overrides: Record<string, unknown> = {}) {
    return manual().create({ actor, input: input(overrides) })
}
async function scope(identityId: string, platformId: string): Promise<HostingActor> {
    const identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
    return { identityId, platformId, tokenVersion: identity.tokenVersion ?? null }
}
async function partnerCourse() {
    const id = apId()
    await ds.getRepository(LmsCourseEntity).save({ id, slug: `manual-${id}`, ownerPlatformId: null, audience: 'partner', certificationMode: 'partner', revision: 1, status: 'published', content: foundingCourseDraft, reviewedBy: actor.identityId, reviewedAt: new Date() })
    return id
}
beforeAll(async () => {
    ds = await migratedHostedPGlite()
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs()
})
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: secret }), operatorId = await identity()
    const home = await bootstrapHostedOperator(ds, onboarding, operatorId)
    actor = { identityId: operatorId, platformId: home.platformId, tokenVersion: home.tokenVersion }
    const otherId = await identity(), otherHome = await onboarding.provision({ identityId: otherId, name: 'Synthetic ordinary client', operator: actor })
    other = { identityId: otherId, platformId: otherHome.platformId, tokenVersion: otherHome.tokenVersion }
})
describe('operator manual accounts and bounded funding', () => {
    it('creates internal Partner Starter only through an operator with 35 non-overlapping monthly Credits and no training', async () => {
        const value = input({ kind: 'partner', planId: 'training', partner: { package: 'starter', approve: false } })
        await expect(manual().create({ actor: other, input: value })).rejects.toThrow('HOSTING_OPERATOR_REQUIRED')
        const result = await manual().create({ actor, input: value }), account = result.account
        expect(account).toMatchObject({ kind: 'partner', package: 'starter', planId: 'training', monthlyCredits: 3500, monthlyCreditCap: 3500, seats: 1, enrollmentId: null })
        expect((await manual().create({ actor, input: value })).replayed).toBe(true)
        const rows = await ds.getRepository(HostingGrantEntity).find({ where: { platformId: account.platformId, meter: 'execution', sourceKey: Like('manual:%') }, order: { validFrom: 'ASC' } })
        expect(rows).toHaveLength(3)
        expect(rows.every(row => row.amount === 3500n)).toBe(true)
        expect(rows[0].validUntil.getTime()).toBe(rows[1].validFrom.getTime())
        expect(rows[1].validUntil.getTime()).toBe(rows[2].validFrom.getTime())
        const learner = await scope(account.identityId, account.platformId)
        const overview = await createHostedBillingView({ dataSource: ds }).read(learner)
        expect(overview).toMatchObject({ accountKind: 'partner', trainingPackage: 'starter', manualFunding: true })
        expect(overview.plans.map(plan => plan.id)).toEqual(['starter', 'team', 'scale'])
        expect(Object.keys(hostingCatalog.partnerPackages)).toEqual(['core', 'launch'])
        expect(await ds.getRepository(LmsEnrollmentEntity).count()).toBe(0)
        // Exhaust this period: a future grant must not fund another execution early.
        await ds.getRepository(HostingGrantEntity).update({ id: rows[0].id }, { consumed: 3500n })
        const projectId = (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: account.platformId })).initialProjectId!
        await expect(createHostedLedger({ dataSource: ds }).reserveExecution({ actor: learner, projectId, key: 'starter-exhausted', payer: 'byok' })).rejects.toThrow('HOSTING_CREDITS_EXHAUSTED')
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: rows[1].id })).reserved).toBe(0n)
    })
    it('rejects a Starter creation above 35 Credits and training entitlement injection', () => {
        expect(() => HostingManualAccountCreate.parse(input({ kind: 'partner', planId: 'training', monthlyCredits: 3501, partner: { package: 'starter', approve: false } }))).toThrow('capped at 35')
        expect(() => HostingManualAccountCreate.parse(input({ kind: 'partner', planId: 'training', partner: { package: 'starter', courseId: apId(), approve: false } }))).toThrow('does not include a training package')
    })
    it('rejects Starter allowance increases and preserves default restoration and monthly renewals', async () => {
        const account = (await created({ kind: 'partner', planId: 'training', partner: { package: 'starter', approve: false } })).account
        const allowance = createHostedCreditAllowance({ dataSource: ds })
        const change = { platformId: account.platformId, expectedRevision: 0, requestKey: apId(), monthlyCredits: 3501, reason: 'Synthetic above-cap request' }
        await expect(allowance.save({ actor, input: change })).rejects.toThrow('HOSTING_PARTNER_STARTER_CREDIT_CAP')
        expect(await ds.getRepository(HostingCreditAllowanceChangeEntity).count()).toBe(0)
        const lower = await allowance.save({ actor, input: { ...change, monthlyCredits: 1000 } })
        expect(lower).toMatchObject({ effectiveMonthlyCredits: 1000, monthlyCreditCap: 3500 })
        const restored = await allowance.save({ actor, input: { ...change, requestKey: apId(), expectedRevision: 1, monthlyCredits: null } })
        expect(restored.effectiveMonthlyCredits).toBe(3500)
        const start = new Date(Date.parse(account.expiresAt) + 1)
        vi.spyOn(tx, 'now').mockResolvedValue(start)
        const renewal = { requestKey: apId(), expectedRevision: 1, expiresAt: new Date(start.getTime() + 40 * 86400_000).toISOString(), reason: 'Synthetic Starter renewal', monthlyCredits: 3501 }
        await expect(manual().renew({ actor, platformId: account.platformId, input: renewal })).rejects.toThrow('HOSTING_PARTNER_STARTER_CREDIT_CAP')
        await expect(manual().renew({ actor, platformId: account.platformId, input: { ...renewal, monthlyCredits: undefined } })).rejects.toThrow('HOSTING_PARTNER_STARTER_MONTHLY_PERIOD_ACTIVE')
        vi.spyOn(tx, 'now').mockResolvedValue(hostingMonthAnniversary(new Date(account.startsAt), 3))
        expect((await manual().renew({ actor, platformId: account.platformId, input: { ...renewal, monthlyCredits: undefined } })).account).toMatchObject({ package: 'starter', monthlyCredits: 3500, fundedMonthlyCredits: 3500, monthlyCreditCap: 3500 })
    })

    it('distinguishes the configured operator from tenant admins and reports the actual Partner package, due date and funded refill', async () => {
        vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', actor.identityId)
        const billing = createHostedBillingView({ dataSource: ds })
        await expect(billing.read(actor)).rejects.toThrow('HOSTING_CUSTOMER_BILLING_REQUIRED')
        expect((await billing.read(other)).accountKind).toBe('trial')
        const client = (await created()).account
        expect(await billing.read(await scope(client.identityId, client.platformId))).toMatchObject({ accountKind: 'client', hostingEndsAt: client.expiresAt, renewalDueAt: client.expiresAt, trainingPackage: null })
        const account = (await created({ kind: 'partner', planId: 'training', partner: { package: 'core', approve: false } })).account
        const learner = await scope(account.identityId, account.platformId)
        const grants = await ds.getRepository(HostingGrantEntity).find({ where: { platformId: account.platformId, meter: 'execution', sourceKey: Like('manual:%') }, order: { validFrom: 'ASC' } })
        const overview = await billing.read(learner)
        expect(overview).toMatchObject({ accountKind: 'partner', trainingPackage: 'core', hostingEndsAt: account.expiresAt, renewalDueAt: account.expiresAt, nextCreditAllowanceAt: grants[1].validFrom.toISOString() })
        const due = new Date(Date.parse(account.startsAt) + 25 * 86400_000)
        await createHostedSubscriptions({ dataSource: ds }).update({ actor, input: { platformId: account.platformId, expectedRevision: 0, requestKey: apId(), renewalDueAt: due.toISOString(), reason: 'Synthetic earlier Partner due date' } })
        expect(await billing.read(learner)).toMatchObject({ accountKind: 'partner', hostingEndsAt: account.expiresAt, renewalDueAt: due.toISOString(), nextCreditAllowanceAt: null })
        const partnerAdmin = createHostedPartnerAdmin({ dataSource: ds, onboarding: createHostedOnboarding({ dataSource: ds, subjectSecret: secret }) })
        const pending = await partnerAdmin.list({ actor, status: 'pending', search: account.email })
        expect(pending.total).toBe(1)
        expect(pending.partners[0]).toMatchObject({ identityId: account.identityId, active: false })
        expect((await partnerAdmin.list({ actor, status: 'active', search: account.email })).total).toBe(0)
    })
    it.each([['starter', 10, 30000], ['team', 30, 120000], ['scale', 100, 400000]] as const)('creates a %s client with correct seats, password and clipped monthly single-Credit funding', async (planId, seats, credits) => {
        const result = await created({ planId })
        expect(result).toMatchObject({ platformId: actor.platformId, replayed: false, account: { kind: 'client', planId, seats, monthlyCredits: credits, emailOwnershipVerified: false } })
        const account = result.account, identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: account.identityId })
        expect(identity.password).not.toBe(initialPassword); expect(await passwordHasher.compare(initialPassword, identity.password)).toBe(true)
        expect(await identityAdmission(ds.manager, identity)).toMatchObject({ verificationMethod: 'operator', admissionSource: 'operator', emailOwnershipVerified: false })
        const rows = await ds.getRepository(HostingGrantEntity).find({ where: { platformId: account.platformId, sourceKey: Like('manual:%'), meter: 'execution' }, order: { validFrom: 'ASC' } })
        expect(rows).toHaveLength(3); expect(rows.every(row => row.amount === BigInt(credits))).toBe(true)
        expect(rows[0].validFrom.toISOString()).toBe(account.startsAt)
        expect(await ds.getRepository(HostingLedgerEntity).findOneBy({ grantId: rows[0].id, operation: 'grant' })).toMatchObject({ amount: BigInt(credits), key: `grant:${rows[0].id}` })
        expect(rows[2].validUntil.toISOString()).toBe(account.expiresAt)
        expect(new Date(account.graceEndsAt).getTime()).toBe(new Date(account.expiresAt).getTime() + 15 * 86400_000)
        expect(await ds.getRepository(HostingStripePeriodEntity).count()).toBe(0); expect(await ds.getRepository(HostingStripeBindingEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
        const serialized = JSON.stringify(await ds.getRepository(HostingManualCommandEntity).find())
        expect(serialized).not.toContain(initialPassword); expect(serialized).not.toContain(identity.password)
        expect(JSON.stringify(result)).not.toContain(initialPassword)
        const learner = await scope(account.identityId, account.platformId)
        const execution = await createHostedLedger({ dataSource: ds }).reserveExecution({ actor: learner, projectId: (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: account.platformId })).initialProjectId, key: 'first-funded-period', payer: 'byok' })
        expect(execution.grantId).toBe(rows[0].id)
    })
    it.each([['starter', 10], ['team', 30], ['scale', 100]] as const)('enforces %s seat capacity including pending invite reservations at the real server boundary', async (planId, seats) => {
        const account = (await created({ planId })).account, learner = await scope(account.identityId, account.platformId)
        const pending = Array.from({ length: seats - 2 }, () => ({ id: apId(), platformId: account.platformId, subject: apId().padEnd(64, 'a'), tokenDigest: apId().padEnd(64, 'b'), role: PlatformRole.MEMBER, status: 'pending' as const, projectUnits: 0, expiresAt: new Date(Date.now() + 86400_000), acceptedIdentityId: null }))
        await ds.getRepository(HostingInvitationEntity).insert(pending)
        const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: secret })
        await expect(onboarding.invite({ actor: learner, email: `last-${planId}@test.invalid`, role: PlatformRole.MEMBER })).resolves.toMatchObject({ id: expect.any(String) })
        await expect(onboarding.invite({ actor: learner, email: `over-${planId}@test.invalid`, role: PlatformRole.MEMBER })).rejects.toThrow('HOSTING_RESOURCE_LIMIT')
        expect(await ds.getRepository(HostingInvitationEntity).countBy({ platformId: account.platformId, status: 'pending', projectUnits: 0 })).toBe(seats - 1)
    })
    it('creates Partner training with one seat and an optional real course, independent assessment and explicit approval only', async () => {
        const courseId = await partnerCourse(), result = await created({ kind: 'partner', planId: 'training', partner: { package: 'core', courseId, approve: false } })
        expect(result.account).toMatchObject({ kind: 'partner', planId: 'training', seats: 1, monthlyCredits: 30000, package: 'core', enrollmentId: expect.any(String) })
        expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: result.account.identityId })).toBe(0)
        const enrollment = await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: result.account.enrollmentId! })
        expect(enrollment).toMatchObject({ identityId: result.account.identityId, workspacePlatformId: result.account.platformId, accessType: 'partner_training', package: 'core', status: 'active', paymentReference: `manual-term:${result.account.termId}` })
        expect(await manualEnrollmentDelivery(ds.manager, enrollment)).toMatchObject({ activated: true, funding: 'manual', revoked: false, endsAt: result.account.expiresAt })
        expect(await ds.getRepository(LmsCertificateEntity).count()).toBe(0); expect(await ds.getRepository(LmsExamAttemptEntity).count()).toBe(0)
        const approved = await created({ kind: 'partner', planId: 'training', partner: { package: 'launch', approve: true } })
        expect(await ds.getRepository(HostingAccessRoleEntity).findOneBy({ id: approved.account.identityId })).toMatchObject({ role: 'partner', active: true })
        expect(approved.account.enrollmentId).toBeNull()
        expect(approved.account.monthlyCredits).toBe(30000)
    })
    it('assigns a published Partner course later using the existing funded term without adding funding, changing revision or certifying', async () => {
        const account = (await created({ kind: 'partner', planId: 'training', partner: { package: 'launch', approve: false } })).account
        const courseId = await partnerCourse(), before = await ds.getRepository(HostingGrantEntity).count()
        const value = { requestKey: apId(), expectedRevision: account.revision, courseId }
        const result = await manual().enroll({ actor, platformId: account.platformId, input: value })
        expect(result.account).toMatchObject({ enrollmentId: expect.any(String), revision: account.revision, termId: account.termId })
        expect(await ds.getRepository(HostingGrantEntity).count()).toBe(before)
        expect(await ds.getRepository(HostingManualTermEntity).count()).toBe(1)
        const enrollment = await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: result.account.enrollmentId! })
        expect(enrollment).toMatchObject({ identityId: account.identityId, courseId, package: 'launch', paymentReference: `manual-term:${account.termId}`, workspacePlatformId: account.platformId })
        expect(await manualEnrollmentDelivery(ds.manager, enrollment)).toMatchObject({ activated: true, funding: 'manual' })
        expect((await manual().enroll({ actor, platformId: account.platformId, input: value })).replayed).toBe(true)
        expect((await manual().enroll({ actor, platformId: account.platformId, input: { ...value, requestKey: apId() } })).replayed).toBe(true)
        await expect(manual().enroll({ actor, platformId: account.platformId, input: { ...value, courseId: await partnerCourse() } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        expect(await ds.getRepository(LmsEnrollmentEntity).count()).toBe(1)
        expect(await ds.getRepository(LmsCertificateEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: account.identityId })).toBe(0)
        expect(await identityAdmission(ds.manager, await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: account.identityId }))).toMatchObject({ admissionSource: 'operator', emailOwnershipVerified: false })
    })
    it('rejects late course assignment for nonoperators, clients, stale revisions, invalid courses and expired funding', async () => {
        const partner = (await created({ kind: 'partner', planId: 'training', partner: { package: 'core', approve: false } })).account
        const courseId = await partnerCourse(), value = { requestKey: apId(), expectedRevision: 1, courseId }
        await expect(manual().enroll({ actor: other, platformId: partner.platformId, input: value })).rejects.toThrow('OPERATOR_REQUIRED')
        const client = (await created()).account
        await expect(manual().enroll({ actor, platformId: client.platformId, input: value })).rejects.toThrow('PARTNER_ACCOUNT_REQUIRED')
        await expect(manual().enroll({ actor, platformId: partner.platformId, input: { ...value, expectedRevision: 2 } })).rejects.toThrow('REVISION_CONFLICT')
        await expect(manual().enroll({ actor, platformId: partner.platformId, input: { ...value, courseId: apId() } })).rejects.toThrow('PARTNER_COURSE_REQUIRED')
        vi.spyOn(tx, 'now').mockResolvedValue(new Date(partner.expiresAt))
        await expect(manual().enroll({ actor, platformId: partner.platformId, input: value })).rejects.toThrow('ACTIVE_TERM_REQUIRED')
        expect(await ds.getRepository(LmsEnrollmentEntity).count()).toBe(0)
    })
    it('enforces the Partner one-seat workspace limit and keeps BYOK separate from managed funding while held work settles after cutoff', async () => {
        const partner = (await created({ kind: 'partner', planId: 'training', partner: { package: 'core', approve: false }, monthlyCredits: 20 })).account
        const learner = await scope(partner.identityId, partner.platformId)
        const invitationsBefore = await ds.getRepository(HostingInvitationEntity).count()
        await expect(createHostedOnboarding({ dataSource: ds, subjectSecret: secret }).invite({ actor: learner, email: 'additional@test.invalid', role: PlatformRole.MEMBER })).rejects.toThrow('HOSTING_PARTNER_SINGLE_USER')
        expect(await ds.getRepository(HostingInvitationEntity).count()).toBe(invitationsBefore)
        const projectId = (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: partner.platformId })).initialProjectId, ledger = createHostedLedger({ dataSource: ds })
        const byok = await ledger.reserveExecution({ actor: learner, projectId, key: 'manual-byok', payer: 'byok' }), byokClaim = await ledger.claimExecution({ actor: learner, reservationId: byok.id })
        await expect(ledger.reserveManagedCall({ actor: learner, rootReservationId: byok.id, key: 'byok-cannot-charge-managed', maxCostMicroUsd: 250n })).rejects.toThrow('BYOK_HAS_NO_MANAGED_ALLOWANCE')
        await ledger.finishExecution({ platformId: partner.platformId, reservationId: byok.id, dispatchId: byokClaim.dispatchId! })
        const root = await ledger.reserveExecution({ actor: learner, projectId, key: 'manual-managed', payer: 'managed' }), rootClaim = await ledger.claimExecution({ actor: learner, reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: learner, rootReservationId: root.id, key: 'held-managed-work', maxCostMicroUsd: 500n }), sent = await ledger.claimManagedCall({ actor: learner, reservationId: call.id })
        expect(call.grantId).toBe(root.grantId)
        vi.spyOn(tx, 'now').mockResolvedValue(new Date(partner.graceEndsAt))
        await expect(ledger.reserveExecution({ actor: learner, projectId, key: 'cannot-admit-after-cutoff', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
        await ledger.settleManagedCall({ platformId: partner.platformId, reservationId: call.id, dispatchId: sent.dispatchId!, actualCostMicroUsd: 250n })
        await ledger.finishExecution({ platformId: partner.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId })
        expect(grant).toMatchObject({ consumed: 2n, reserved: 0n })
        expect(await ds.getRepository(HostingRootCreditUsageEntity).findOneByOrFail({ id: root.id })).toMatchObject({ consumedCredits: 1n, reservedCredits: 0n, settledSupplierMicroUsd: 250n })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: partner.platformId })).activeExecutions).toBe(0)
    })
    it('never overwrites an existing identity, including differently cased email, and rejects nonoperators or stale sessions', async () => {
        const existing = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: other.identityId })
        await expect(manual().create({ actor, input: input({ email: existing.email.toUpperCase() }) })).rejects.toThrow('EMAIL_EXISTS')
        expect(await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: existing.id })).toEqual(existing)
        await expect(manual().create({ actor: other, input: input() })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(manual().create({ actor: { ...actor, tokenVersion: 'stale' }, input: input() })).rejects.toThrow('OPERATOR_REQUIRED')
        expect(await ds.getRepository(HostingManualAccountEntity).count()).toBe(0)
    })
    it('replays the same canonical request without new grants or resetting dates and rejects a changed password or fields', async () => {
        const value = input(), first = await manual().create({ actor, input: value })
        const replay = await manual().create({ actor, input: { ...value } })
        expect(replay).toMatchObject({ replayed: true, account: first.account })
        expect(await ds.getRepository(HostingManualTermEntity).count()).toBe(1)
        await expect(manual().create({ actor, input: { ...value, password: 'DifferentSyntheticPass123!' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        await expect(manual().create({ actor, input: { ...value, companyName: 'Different company' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        expect(await ds.getRepository(HostingManualCommandEntity).count()).toBe(1)
        await expect(ds.getRepository(HostingManualTermEntity).update({ id: first.account.termId }, { monthlyCredits: 99999 })).rejects.toThrow('HISTORY_IMMUTABLE')
        await expect(ds.getRepository(HostingManualCommandEntity).delete({ platformId: first.account.platformId })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it('does not issue or expose any future month early, preserves the last remainder during grace, and disables exactly fifteen days late', async () => {
        const result = await created({ monthlyCredits: 3 }), account = result.account
        const learner = await scope(account.identityId, account.platformId), ledger = createHostedLedger({ dataSource: ds })
        const projectId = (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: account.platformId })).initialProjectId
        const grants = await ds.getRepository(HostingGrantEntity).find({ where: { platformId: account.platformId, meter: 'execution', sourceKey: Like('manual:%') }, order: { validFrom: 'ASC' } })
        const clock = vi.spyOn(tx, 'now').mockResolvedValue(grants[0].validFrom)
        await ds.getRepository(HostingGrantEntity).update({ id: grants[0].id }, { consumed: 3n })
        await expect(ledger.reserveExecution({ actor: learner, projectId, key: 'cannot-use-next-month', payer: 'byok' })).rejects.toThrow('CREDITS_EXHAUSTED')
        clock.mockResolvedValue(new Date(Date.parse(account.expiresAt) + 1))
        const grace = await ledger.reserveExecution({ actor: learner, projectId, key: 'last-month-remainder', payer: 'byok' })
        expect(grace.grantId).toBe(grants.at(-1)!.id)
        const before = await ds.getRepository(HostingGrantEntity).count()
        clock.mockResolvedValue(new Date(Date.parse(account.graceEndsAt)))
        await expect(ledger.reserveExecution({ actor: learner, projectId, key: 'exact-cutoff', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
        expect(await ds.getRepository(HostingGrantEntity).count()).toBe(before)
        expect((await manual().read({ actor, platformId: account.platformId })).account.expiresAt).toBe(account.expiresAt)
    })
    it('allows an explicit due-date override bound to manual provenance without issuing funding, then renews an expired term exactly once preserving old liabilities', async () => {
        const first = (await created({ monthlyCredits: 20 })).account, learner = await scope(first.identityId, first.platformId)
        const grants = await ds.getRepository(HostingGrantEntity).find({ where: { platformId: first.platformId, meter: 'execution', sourceKey: Like('manual:%') }, order: { validFrom: 'ASC' } })
        const ledger = createHostedLedger({ dataSource: ds }), projectId = (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: first.platformId })).initialProjectId
        const clock = vi.spyOn(tx, 'now').mockResolvedValue(grants.at(-1)!.validFrom)
        const root = await ledger.reserveExecution({ actor: learner, projectId, key: 'old-paid-work', payer: 'byok' }), claim = await ledger.claimExecution({ actor: learner, reservationId: root.id })
        const before = await ds.getRepository(HostingGrantEntity).count()
        const due = new Date(Date.parse(first.expiresAt) + 3 * 86400_000)
        const override = await createHostedSubscriptions({ dataSource: ds }).update({ actor, input: { platformId: first.platformId, expectedRevision: 0, requestKey: apId(), renewalDueAt: due.toISOString(), reason: 'Explicit synthetic manual due date' } })
        expect(override.boundPeriod?.sourceKey).toContain('manual:starter:')
        expect(await ds.getRepository(HostingGrantEntity).count()).toBe(before)
        const nextStart = new Date(Date.parse(first.expiresAt) + 86400_000)
        const renewal = { requestKey: apId(), expectedRevision: 1, expiresAt: new Date(nextStart.getTime() + 40 * 86400_000).toISOString(), reason: 'Additional manual funding was confirmed', monthlyCredits: 30 }
        await expect(manual().renew({ actor, platformId: first.platformId, input: renewal })).rejects.toThrow('ACTIVE_TERM_REQUIRES_REVIEW')
        clock.mockResolvedValue(nextStart)
        const renewed = await manual().renew({ actor, platformId: first.platformId, input: renewal })
        expect(renewed.account).toMatchObject({ revision: 2, monthlyCredits: 30, startsAt: nextStart.toISOString() })
        expect(Date.parse(renewed.account.graceEndsAt)).toBe(Date.parse(renewal.expiresAt) + 15 * 86400_000)
        expect((await manual().renew({ actor, platformId: first.platformId, input: renewal })).replayed).toBe(true)
        expect(await ds.getRepository(HostingManualTermEntity).count()).toBe(2)
        await ledger.finishExecution({ platformId: first.platformId, reservationId: root.id, dispatchId: claim.dispatchId! })
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId })).consumed).toBe(1n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: first.platformId })).activeExecutions).toBe(0)
    })
    it('binds an earlier due date to its closing month and never refills during day25-to40 grace', async () => {
        const account = (await created({ monthlyCredits: 5 })).account, learner = await scope(account.identityId, account.platformId)
        const rows = await ds.getRepository(HostingGrantEntity).find({ where: { platformId: account.platformId, sourceKey: Like('manual:%'), meter: 'execution' }, order: { validFrom: 'ASC' } })
        const starts = Date.parse(account.startsAt), due = new Date(starts + 25 * 86400_000)
        const override = await createHostedSubscriptions({ dataSource: ds }).update({ actor, input: { platformId: account.platformId, expectedRevision: 0, requestKey: apId(), renewalDueAt: due.toISOString(), reason: 'Synthetic earlier manual expiration' } })
        expect(override.boundPeriod?.executionGrantId).toBe(rows[0].id)
        const projectId = (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: account.platformId })).initialProjectId, ledger = createHostedLedger({ dataSource: ds })
        const clock = vi.spyOn(tx, 'now').mockResolvedValue(due)
        for (const day of [25, 31, 39]) {
            clock.mockResolvedValue(new Date(starts + day * 86400_000))
            const reservation = await ledger.reserveExecution({ actor: learner, projectId, key: `early-due-day-${day}`, payer: 'byok' })
            expect(reservation.grantId).toBe(rows[0].id)
            await ledger.releaseUnsent({ actor: learner, reservationId: reservation.id })
        }
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: rows[1].id })).reserved).toBe(0n)
        clock.mockResolvedValue(new Date(starts + 40 * 86400_000))
        await expect(ledger.reserveExecution({ actor: learner, projectId, key: 'early-due-cutoff', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
    })
    it('closes the prior month at an exact anniversary and blocks every grant when due precedes delivery', async () => {
        const account = (await created()).account, learner = await scope(account.identityId, account.platformId)
        const rows = await ds.getRepository(HostingGrantEntity).find({ where: { platformId: account.platformId, sourceKey: Like('manual:%'), meter: 'execution' }, order: { validFrom: 'ASC' } })
        const subscriptions = createHostedSubscriptions({ dataSource: ds })
        const boundary = await subscriptions.update({ actor, input: { platformId: account.platformId, expectedRevision: 0, requestKey: apId(), renewalDueAt: rows[1].validFrom.toISOString(), reason: 'Synthetic exact anniversary due' } })
        expect(boundary.boundPeriod?.executionGrantId).toBe(rows[0].id)
        const beforeDelivery = new Date(Date.parse(account.startsAt) - 86400_000)
        await subscriptions.update({ actor, input: { platformId: account.platformId, expectedRevision: 1, requestKey: apId(), renewalDueAt: beforeDelivery.toISOString(), reason: 'Synthetic due before term delivery' } })
        const projectId = (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: account.platformId })).initialProjectId
        await expect(createHostedLedger({ dataSource: ds }).reserveExecution({ actor: learner, projectId, key: 'no-grant-after-early-due', payer: 'byok' })).rejects.toThrow('GRANT_EXPIRED')
    })
    it('preserves a custom monthly allowance when a renewal omits it', async () => {
        const account = (await created({ monthlyCredits: 37 })).account
        const start = new Date(Date.parse(account.expiresAt) + 1)
        vi.spyOn(tx, 'now').mockResolvedValue(start)
        const result = await manual().renew({ actor, platformId: account.platformId, input: { requestKey: apId(), expectedRevision: 1, expiresAt: new Date(start.getTime() + 40 * 86400_000).toISOString(), reason: 'Synthetic preserved custom allowance' } })
        expect(result.account.monthlyCredits).toBe(37)
    })
    it('supports bounded audited monthly allowance changes on current and future manual grants without touching historical liabilities', async () => {
        const account = (await created({ monthlyCredits: 10 })).account
        await createHostedCreditAllowance({ dataSource: ds }).save({ actor, input: { platformId: account.platformId, expectedRevision: 0, requestKey: apId(), monthlyCredits: 25, reason: 'Synthetic audited allowance adjustment' } })
        const grants = await ds.getRepository(HostingGrantEntity).findBy({ platformId: account.platformId, sourceKey: Like('manual:%'), meter: 'execution' })
        expect(grants).toHaveLength(3); expect(grants.every(grant => grant.amount === 25n)).toBe(true)
    })
    it('blocks client and Partner Stripe purchases before any customer, binding, session or grant mutation', async () => {
        const account = (await created()).account, learner = await scope(account.identityId, account.platformId)
        const catalog = { version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_team', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } }
        vi.stubEnv('AP_HOSTED_BILLING_MODE', 'stripe_test'); vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_test_synthetic'); vi.stubEnv('AP_HOSTED_STRIPE_WEBHOOK_SECRET', 'whsec_synthetic'); vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify(catalog))
        const before = await ds.getRepository(HostingGrantEntity).count()
        remote.create.mockClear()
        await expect((await createHostedStripe({ dataSource: ds })).checkout(learner, 'starter')).rejects.toThrow('MANUAL_FUNDING_REQUIRES_REVIEW')
        const adapter = { customer: vi.fn(), create: vi.fn(), snapshot: vi.fn() }
        const policy = { secret: 'sk_test_synthetic', signingSecret: 'whsec_synthetic', hash: 'synthetic', catalog, partnerCourseId: await partnerCourse(), partnerPackages: { core: { priceId: 'price_core', amountMinor: 100000, currency: 'usd' }, guided: { priceId: 'price_guided', amountMinor: 120000, currency: 'usd' } } } as PartnerStripePolicy
        await expect((await createHostedPartnerBilling({ dataSource: ds, policy, adapter })).checkout(learner, 'core')).rejects.toThrow('MANUAL_FUNDING_REQUIRES_REVIEW')
        expect(remote.create).not.toHaveBeenCalled(); expect(adapter.customer).not.toHaveBeenCalled(); expect(adapter.create).not.toHaveBeenCalled()
        expect(await ds.getRepository(HostingStripeBindingEntity).count()).toBe(0); expect(await ds.getRepository(HostingPartnerPurchaseEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingGrantEntity).count()).toBe(before)
        const overview = await createHostedBillingView({ dataSource: ds }).read(learner)
        expect(overview.plans.every(plan => !plan.checkout.enabled && plan.checkout.reason === 'billing_review')).toBe(true)
        expect(overview.portal.enabled).toBe(false)
    })
    it('uses funded manual credits as the allowance default and preserves an effective override on omitted renewal', async () => {
        const account = (await created({ monthlyCredits: 37 })).account, allowances = createHostedCreditAllowance({ dataSource: ds })
        expect(await allowances.read({ actor, platformId: account.platformId })).toMatchObject({ defaultMonthlyCredits: 37, effectiveMonthlyCredits: 37 })
        await allowances.save({ actor, input: { platformId: account.platformId, expectedRevision: 0, requestKey: apId(), monthlyCredits: 45, reason: 'Synthetic explicit manual allowance override' } })
        expect((await manual().read({ actor, platformId: account.platformId })).account).toMatchObject({ monthlyCredits: 45, fundedMonthlyCredits: 37 })
        await allowances.save({ actor, input: { platformId: account.platformId, expectedRevision: 1, requestKey: apId(), monthlyCredits: null, reason: 'Synthetic reset to funded manual default' } })
        expect(await allowances.read({ actor, platformId: account.platformId })).toMatchObject({ defaultMonthlyCredits: 37, effectiveMonthlyCredits: 37 })
        expect((await ds.getRepository(HostingGrantEntity).findBy({ platformId: account.platformId, sourceKey: Like('manual:%'), meter: 'execution' })).every(grant => grant.amount === 37n)).toBe(true)
        await allowances.save({ actor, input: { platformId: account.platformId, expectedRevision: 2, requestKey: apId(), monthlyCredits: 45, reason: 'Synthetic renewed effective allowance' } })
        const startsAt = new Date(Date.parse(account.expiresAt) + 1)
        vi.spyOn(tx, 'now').mockResolvedValue(startsAt)
        const renewed = await manual().renew({ actor, platformId: account.platformId, input: { requestKey: apId(), expectedRevision: 1, expiresAt: new Date(startsAt.getTime() + 40 * 86400_000).toISOString(), reason: 'Synthetic preserve effective custom allowance' } })
        expect(renewed.account).toMatchObject({ monthlyCredits: 45, fundedMonthlyCredits: 45 })
        expect(await effectiveHostedCredits(ds.manager, account.platformId, 'starter')).toBe(45)
    })
    it('audits an explicit renewal amount over an old override in the same transaction without rewriting held old-term funding', async () => {
        const account = (await created({ monthlyCredits: 20 })).account, allowances = createHostedCreditAllowance({ dataSource: ds })
        await allowances.save({ actor, input: { platformId: account.platformId, expectedRevision: 0, requestKey: apId(), monthlyCredits: 25, reason: 'Synthetic old term override' } })
        const term = await ds.getRepository(HostingManualTermEntity).findOneByOrFail({ id: account.termId }), periods = manualTermPeriods(term), last = periods.at(-1)!
        const clock = vi.spyOn(tx, 'now').mockResolvedValue(last.from)
        const learner = await scope(account.identityId, account.platformId), ledger = createHostedLedger({ dataSource: ds }), projectId = (await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: account.platformId })).initialProjectId
        const root = await ledger.reserveExecution({ actor: learner, projectId, key: 'held-override-old-term', payer: 'managed' }), rootClaim = await ledger.claimExecution({ actor: learner, reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: learner, rootReservationId: root.id, key: 'held-override-managed', maxCostMicroUsd: 500n }), sent = await ledger.claimManagedCall({ actor: learner, reservationId: call.id })
        const old = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId })
        const startsAt = new Date(Date.parse(account.expiresAt) + 1); clock.mockResolvedValue(startsAt)
        const result = await manual().renew({ actor, platformId: account.platformId, input: { requestKey: apId(), expectedRevision: 1, expiresAt: new Date(startsAt.getTime() + 40 * 86400_000).toISOString(), monthlyCredits: 12, reason: 'Synthetic explicit newly funded allowance' } })
        expect(result.account).toMatchObject({ monthlyCredits: 12, fundedMonthlyCredits: 12 })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: old.id })).toEqual(old)
        const current = await ds.getRepository(HostingGrantEntity).findBy({ platformId: account.platformId, sourceKey: Like(`manual:starter:${result.account.termId}:%`), meter: 'execution' })
        expect(current).toHaveLength(2); expect(current.every(grant => grant.amount === 12n)).toBe(true)
        const audit = await ds.getRepository(HostingCreditAllowanceChangeEntity).findOneByOrFail({ platformId: account.platformId, revision: 2 })
        expect(audit.monthlyCredits).toBe(12); expect(audit.grantSnapshots.every(grant => grant.sourceKey.includes(result.account.termId))).toBe(true)
        await ledger.settleManagedCall({ platformId: account.platformId, reservationId: call.id, dispatchId: sent.dispatchId!, actualCostMicroUsd: 250n })
        await ledger.finishExecution({ platformId: account.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: old.id }))).toMatchObject({ amount: 25n, consumed: 1n, reserved: 0n })
        expect(await ds.getRepository(HostingRootCreditUsageEntity).findOneByOrFail({ id: root.id })).toMatchObject({ consumedCredits: 1n, reservedCredits: 0n, settledSupplierMicroUsd: 250n })
    })
    it('rejects invalid expiry, overlong funding, unpublished/nonpartner courses and self-hosted activation atomically', async () => {
        await expect(created({ expiresAt: new Date(Date.now() - 1).toISOString() })).rejects.toThrow('DATE_INVALID')
        await expect(created({ expiresAt: new Date(Date.now() + 37 * 31 * 86400_000).toISOString() })).rejects.toThrow('DATE_INVALID')
        await expect(created({ kind: 'partner', planId: 'training', partner: { package: 'core', courseId: apId(), approve: true } })).rejects.toThrow('PARTNER_COURSE_REQUIRED')
        expect(await ds.getRepository(HostingManualAccountEntity).count()).toBe(0)
        vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
        expect(() => manual()).toThrow('HOSTED_INSTALLATION_REQUIRED')
    })
    it('preserves January anniversary anchors and clips a partial final period at the exact expiration', () => {
        const periods = manualTermPeriods({ startsAt: new Date('2028-01-31T14:12:00Z'), expiresAt: new Date('2028-04-15T08:00:00Z') })
        expect(periods.map(period => period.from.toISOString())).toEqual(['2028-01-31T14:12:00.000Z', '2028-02-29T14:12:00.000Z', '2028-03-31T14:12:00.000Z'])
        expect(periods.at(-1)!.until.toISOString()).toBe('2028-04-15T08:00:00.000Z')
    })
})
