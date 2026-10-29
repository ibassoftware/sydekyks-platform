import { apId } from '@activepieces/core-utils'
import { hostingCatalog, PlatformRole } from '@activepieces/shared'
import { DataSource, Like } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { HostingAccountEntity, HostingGrantEntity, HostingInvitationEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPartnerBilling, partnerRefundPolicy } from '../../src/app/hosting/hosting-partner-billing'
import { PartnerPaymentEvidence, PartnerStripePolicy } from '../../src/app/hosting/hosting-partner-billing-adapter'
import { HostingPartnerPurchaseAuditEntity, HostingPartnerPurchaseEntity, PartnerPurchase } from '../../src/app/hosting/hosting-partner-billing-entities'
import { createHostedTraining } from '../../src/app/hosting/hosting-training'
import { HostingTrainingEntity } from '../../src/app/hosting/hosting-training-entity'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../src/app/lms/lms-content'
import { LmsCertificateEntity, LmsCourseEntity, LmsEnrollmentEntity } from '../../src/app/lms/lms-entities'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, actor: HostingActor, operator: HostingActor, policy: PartnerStripePolicy
let evidence: 'open' | 'paid', refundedMinor: number
const adapter = {
    customer: vi.fn(async (_row: PartnerPurchase) => 'cus_synthetic'),
    create: vi.fn(async (_row: PartnerPurchase) => ({ sessionId: 'cs_synthetic', checkoutUrl: 'https://checkout.stripe.com/c/pay/synthetic', expiresAt: new Date(Date.now() + 3600_000) })),
    snapshot: vi.fn(async (row: PartnerPurchase): Promise<PartnerPaymentEvidence> => evidence === 'open' ? { status: 'open' } : { status: 'paid', sessionId: row.sessionId!, customerId: row.customerId!, paymentIntentId: 'pi_synthetic', chargeId: 'ch_synthetic', amountMinor: row.amountMinor, refundedMinor, evidenceHash: 'synthetic-evidence-hash' }),
}
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-partner-purchase-secret-at-least32chars' })
const service = () => createHostedPartnerBilling({ dataSource: ds, policy, adapter })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', verified: true, password: 'unused', firstName: 'Partner', lastName: 'Test', tokenVersion: 'initial' })
    return id
}
async function recover() {
    await ds.getRepository(HostingPartnerPurchaseEntity).createQueryBuilder().update().set({ reconcileAt: new Date(0) }).execute()
    await (await service()).recover()
}
beforeAll(async () => {
    ds = await migratedHostedPGlite() 
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy() 
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.clearAllMocks(); evidence = 'open'; refundedMinor = 0
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_BILLING_MODE', 'stripe_test'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const operatorId = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), operatorId)
    operator = { identityId: operatorId, platformId: home.platformId, tokenVersion: home.tokenVersion }
    const identityId = await identity(), tenant = await onboarding().provision({ identityId, name: 'Partner workspace', operator })
    actor = { identityId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion }
    const courseId = apId()
    await ds.getRepository(LmsCourseEntity).save({ id: courseId, slug: 'partner-receipt-test', ownerPlatformId: null, audience: 'partner', certificationMode: 'partner', revision: 1, status: 'published', content: foundingCourseDraft, reviewedBy: operatorId, reviewedAt: new Date() })
    policy = { secret: 'sk_test_synthetic', signingSecret: 'whsec_synthetic', hash: 'synthetic-policy', catalog: { accountId: 'acct_synthetic', version: hostingCatalog.version, origin: 'http://localhost', portalConfigurationId: 'bpc_synthetic', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_team', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } }, partnerCourseId: courseId, partnerPackages: { core: { priceId: 'price_core', amountMinor: 100000, currency: 'usd' }, guided: { priceId: 'price_guided', amountMinor: 120000, currency: 'usd' } } } as PartnerStripePolicy
})
describe('durable Partner receipts with migrated LMS and ledger', () => {
    it.each(['core', 'guided'] as const)('fulfills %s exactly once without approval/certification and never extends it on replay', async selected => {
        const api = await service()
        expect((await api.status(actor)).available).toBe(true)
        await api.checkout(actor, selected)
        expect(await ds.getRepository(LmsEnrollmentEntity).count()).toBe(0)
        evidence = 'paid'; await recover()
        const row = await ds.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ platformId: actor.platformId })
        expect(row.state).toBe('fulfilled')
        const training = await ds.getRepository(HostingTrainingEntity).findOneByOrFail({ id: row.trainingId! })
        const grants = await ds.getRepository(HostingGrantEntity).findBy({ platformId: actor.platformId, sourceKey: Like(`training:${training.id}:%`), meter: 'execution' })
        expect(grants).toHaveLength(12); expect(grants.every(grant => grant.amount === 30000n)).toBe(true)
        expect(training.endsAt.getUTCFullYear()).toBe(training.startsAt.getUTCFullYear() + 1)
        expect(await ds.getRepository(LmsCertificateEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingAccessRoleEntity).count()).toBe(0)
        await recover(); await api.checkout(actor, selected)
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(1)
        expect((await ds.getRepository(HostingTrainingEntity).findOneByOrFail({ id: training.id })).endsAt).toEqual(training.endsAt)
        expect(await ds.getRepository(LmsEnrollmentEntity).count()).toBe(1)
        expect(await ds.getRepository(HostingGrantEntity).countBy({ platformId: actor.platformId, sourceKey: Like(`training:${training.id}:%`), meter: 'execution' })).toBe(12)
        await expect(api.checkout(actor, selected === 'core' ? 'guided' : 'core')).rejects.toThrow('CONFLICT')
        expect(adapter.create).toHaveBeenCalledTimes(1)
    })
    it('preserves partial refunds, revokes only receipt grants on full refund, and leaves consumed/reserved liability and newer term intact', async () => {
        evidence = 'paid'; await (await service()).checkout(actor, 'core')
        const row = await ds.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ platformId: actor.platformId })
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, sourceKey: `training:${row.trainingId}:0`, meter: 'execution' })
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { consumed: 200n, reserved: 100n })
        refundedMinor = 100; await recover()
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: grant.id })).revokedAt).toBeNull()
        const newerUntil = new Date(Date.now() + 500 * 86400_000)
        await ds.getRepository(HostingAccountEntity).update({ id: actor.platformId }, { validUntil: newerUntil })
        refundedMinor = 100000; await recover()
        expect((await ds.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id: row.id })).state).toBe('refunded')
        expect((await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: row.enrollmentId! })).status).toBe('revoked')
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: grant.id })).toMatchObject({ consumed: 200n, reserved: 100n, revokedAt: expect.any(Date) })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).validUntil).toEqual(newerUntil)
        const ledger = await ds.getRepository(HostingLedgerEntity).findOneByOrFail({ grantId: grant.id, operation: 'revoke' })
        expect(ledger.amount).toBe(29700n)
        await recover()
        expect(await ds.getRepository(HostingLedgerEntity).countBy({ grantId: grant.id, operation: 'revoke' })).toBe(1)
        await expect(ds.getRepository(HostingPartnerPurchaseAuditEntity).update({ purchaseId: row.id }, { event: 'tampered' })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it('continues old fulfilled receipt refund monitoring when the current sale catalog changes', async () => {
        evidence = 'paid'; await (await service()).checkout(actor, 'guided')
        policy = { ...policy, hash: 'new-policy', partnerCourseId: apId(), partnerPackages: { ...policy.partnerPackages, guided: { ...policy.partnerPackages.guided, priceId: 'price_newguided' } } }
        refundedMinor = 120000; await recover()
        expect((await ds.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ platformId: actor.platformId })).state).toBe('refunded')
    })
    it('refuses paid activation if another enrollment or additional workspace resources appeared after Checkout', async () => {
        await (await service()).checkout(actor, 'core')
        await ds.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId: actor.identityId, courseId: policy.partnerCourseId, grantPlatformId: null, accessType: 'partner_course', package: null, paymentReference: null, workspacePlatformId: null, startsAt: new Date(), accessUntil: new Date(Date.now() + 86400_000), assessmentUntil: new Date(Date.now() + 86400_000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: operator.identityId })
        evidence = 'paid'; await recover()
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
        expect((await ds.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ platformId: actor.platformId })).reason).toBe('HOSTING_PARTNER_PURCHASE_REQUIRES_REVIEW')
    })
    it('rechecks pending workspace capacity when a payment completes', async () => {
        await (await service()).checkout(actor, 'core')
        await ds.getRepository(HostingInvitationEntity).insert({ id: apId(), platformId: actor.platformId, subject: 'a'.repeat(64), tokenDigest: 'b'.repeat(64), role: PlatformRole.MEMBER, projectUnits: 1, status: 'pending', expiresAt: new Date(Date.now() + 86400_000), acceptedIdentityId: null })
        evidence = 'paid'; await recover()
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(0)
        expect((await (await service()).status(actor)).purchase?.state).toBe('review')
    })
    it('leases concurrent checkout requests and does not create a second remote session', async () => {
        let release!: () => void
        const waiting = new Promise<void>(resolve => {
            release = resolve 
        })
        adapter.create.mockImplementationOnce(async () => {
            await waiting; return { sessionId: 'cs_synthetic', checkoutUrl: 'https://checkout.stripe.com/c/pay/synthetic', expiresAt: new Date(Date.now() + 3600_000) } 
        })
        const api = await service(), first = api.checkout(actor, 'core')
        await vi.waitFor(() => expect(adapter.create).toHaveBeenCalledTimes(1))
        const concurrent = await api.checkout(actor, 'core')
        expect(concurrent.url).toBeNull()
        release(); await first
        expect(adapter.customer).toHaveBeenCalledTimes(1); expect(adapter.create).toHaveBeenCalledTimes(1)
    })
    it('serializes manual receipt activation during provider network work without replacing the manual funding', async () => {
        let release!: () => void
        const waiting = new Promise<void>(resolve => {
            release = resolve 
        })
        adapter.snapshot.mockImplementationOnce(async row => {
            await waiting; return { status: 'paid', sessionId: row.sessionId!, customerId: row.customerId!, paymentIntentId: 'pi_synthetic', chargeId: 'ch_synthetic', amountMinor: row.amountMinor, refundedMinor: 0, evidenceHash: 'synthetic' } 
        })
        const pending = (await service()).checkout(actor, 'core')
        await vi.waitFor(() => expect(adapter.snapshot).toHaveBeenCalledTimes(1))
        const now = new Date(), enrollment = await ds.getRepository(LmsEnrollmentEntity).save({ id: apId(), identityId: actor.identityId, courseId: policy.partnerCourseId, grantPlatformId: null, accessType: 'partner_training', package: 'core', paymentReference: 'manual-synthetic-receipt', workspacePlatformId: actor.platformId, startsAt: now, accessUntil: new Date(now.getTime() + 365 * 86400_000), assessmentUntil: new Date(now.getTime() + 90 * 86400_000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: operator.identityId })
        await createHostedTraining({ dataSource: ds }).activate({ actor: operator, platformId: actor.platformId, identityId: actor.identityId, enrollmentId: enrollment.id, receiptId: 'manual-synthetic-receipt', tier: 'core' })
        release(); await expect(pending).rejects.toThrow('REQUIRES_REVIEW')
        expect(await ds.getRepository(HostingTrainingEntity).count()).toBe(1)
        expect((await ds.getRepository(HostingTrainingEntity).findOneByOrFail({ platformId: actor.platformId })).receiptId).toBe('manual-synthetic-receipt')
    })
    it('keeps manual mode usable and rejects invalid refund amounts', async () => {
        vi.stubEnv('AP_HOSTED_BILLING_MODE', 'manual')
        expect(await (await service()).status(actor)).toMatchObject({ billingMode: 'manual', available: false, reason: 'manual' })
        expect(partnerRefundPolicy(100000, 100)).toBe('preserve'); expect(partnerRefundPolicy(100000, 100000)).toBe('revoke')
        expect(() => partnerRefundPolicy(100000, 100001)).toThrow('REFUND_UNVERIFIED')
        await expect(createHostedTraining({ dataSource: ds }).activateVerifiedPurchase(apId())).rejects.toThrow()
    })
})
