import { apId } from '@activepieces/core-utils'
import { hostingCatalog } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { createHostedCreditAllowance } from '../../src/app/hosting/hosting-credit-allowance'
import { HostingCreditAllowanceChangeEntity } from '../../src/app/hosting/hosting-credit-allowance-entities'
import { createHostedAiAllowance } from '../../src/app/hosting/hosting-ai-allowance'
import { HostingAiAllowanceChangeEntity } from '../../src/app/hosting/hosting-ai-allowance-entities'
import { createHostedBillingView } from '../../src/app/hosting/hosting-billing-view'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedStripe } from '../../src/app/hosting/hosting-stripe'
import { HostingStripeBindingEntity, HostingStripeCommandEntity, HostingStripePeriodEntity } from '../../src/app/hosting/hosting-stripe-entities'
import { subscriptionAccountActive } from '../../src/app/hosting/hosting-subscription-policy'
import { createHostedSubscriptions } from '../../src/app/hosting/hosting-subscriptions'
import { readStripePolicy } from '../../src/app/hosting/hosting-stripe-policy'
import { createHostedTraining } from '../../src/app/hosting/hosting-training'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../src/app/lms/lms-content'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../../src/app/lms/lms-entities'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const supplier = vi.hoisted(() => ({ snapshot: vi.fn() }))
// Only the external Stripe transport is synthetic. Reconciliation, paid-period
// creation, idempotence, revocation and allowance authority are real services.
vi.mock('../../src/app/hosting/hosting-stripe-adapter', () => ({ createStripeAdapter: async () => ({ snapshot: supplier.snapshot }) }))
let ds: DataSource, actor: HostingActor, client: Awaited<ReturnType<typeof makeClient>>
const allowance = () => createHostedCreditAllowance({ dataSource: ds })
const read = () => allowance().read({ actor, platformId: client.platformId })
const save = (revision: number, key: string, monthlyCredits: number | null) => allowance().save({ actor, input: { platformId: client.platformId, expectedRevision: revision, requestKey: key, monthlyCredits, reason: 'Synthetic manually agreed allowance' } })
const grants = () => ds.getRepository(HostingGrantEntity).find({ where: { platformId: client.platformId, meter: 'managed_ai' }, order: { validFrom: 'ASC', id: 'ASC' } })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', verified: true, password: 'unused', firstName: 'Allowance', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
async function makeClient() {
    const identityId = await identity(), tenant = await createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-allowance-subject-at-least32characters' }).provision({ identityId, name: 'Client', operator: actor })
    return { ...tenant, identityId, actor: { identityId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion } }
}
async function training() {
    const binding = { actor, platformId: client.platformId, identityId: client.identityId, enrollmentId: apId(), receiptId: apId(), tier: 'core' as const }
    const courseId = apId(), now = new Date()
    await ds.getRepository(LmsCourseEntity).insert({ id: courseId, slug: `synthetic-${courseId}`, ownerPlatformId: null, audience: 'partner', certificationMode: 'partner', revision: 1, status: 'published', content: foundingCourseDraft, reviewedBy: actor.identityId, reviewedAt: now })
    await ds.getRepository(LmsEnrollmentEntity).insert({ id: binding.enrollmentId, courseId, identityId: binding.identityId, grantPlatformId: null, accessType: 'partner_training', package: binding.tier, paymentReference: binding.receiptId, workspacePlatformId: binding.platformId, startsAt: now, accessUntil: new Date(now.getTime() + 365 * 86400000), assessmentUntil: new Date(now.getTime() + 90 * 86400000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
    await createHostedTraining({ dataSource: ds }).activate(binding)
    return binding
}
async function paid(planId: 'starter' | 'team' | 'scale' = 'starter') {
    vi.stubEnv('AP_HOSTED_BILLING_MODE', 'stripe_test')
    vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_test_synthetic')
    vi.stubEnv('AP_HOSTED_STRIPE_WEBHOOK_SECRET', 'whsec_synthetic')
    vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify({ version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_team', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } }))
    const policy = readStripePolicy(), bindingId = apId(), commandId = apId(), now = Math.floor(Date.now() / 1000), end = now + 30 * 86400
    await ds.getRepository(HostingStripeBindingEntity).insert({ id: bindingId, platformId: client.platformId, stripeAccountId: policy.catalog.accountId, catalogHash: policy.hash, customerId: 'cus_synthetic', holds: [], revision: 0, reconcileAt: new Date(0) })
    async function command(id: string, planId: 'starter' | 'team' | 'scale') {
        await ds.getRepository(HostingStripeCommandEntity).insert({ id, platformId: client.platformId, kind: 'checkout', state: 'closed', actorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion, payload: { customerId: 'cus_synthetic', planId }, payloadHash: 'synthetic', idempotencyKey: apId() })
    }
    await command(commandId, planId)
    const period = { subscriptionId: 'sub_synthetic', itemId: `si_${planId}`, priceId: `price_${planId}`, planId, start: now - 60, end, invoiceId: 'in_first', lineId: 'il_first', chargeId: 'ch_first' }
    const snapshot = { customerPlatformId: client.platformId, subscriptionPlatformId: client.platformId, subscriptionId: 'sub_synthetic', subscriptionStatus: 'active', commandId, period, charges: [] as { id: string, refunded: boolean, lost: boolean, holds: string[] }[], issues: [] }
    supplier.snapshot.mockResolvedValue(snapshot)
    const stripe = await createHostedStripe({ dataSource: ds })
    async function recover() {
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { reconcileAt: new Date(0) })
        await stripe.recover()
    }
    return { snapshot, period, recover, command, end }
}
beforeAll(async () => {
    ds = await migratedHostedPGlite()
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const id = await identity(), home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-allowance-subject-at-least32characters' }), id)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', id)
    actor = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }
    client = await makeClient()
    supplier.snapshot.mockReset()
})

describe('one shared Credits allowance', () => {
    it('requires current operator authority and a reason, and keeps trial and assessment fixed', async () => {
        await expect(allowance().read({ actor: client.actor, platformId: client.platformId })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(allowance().read({ actor: { ...actor, tokenVersion: 'stale' }, platformId: client.platformId })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(save(0, 'trial-fixed', 7000)).rejects.toThrow('FIXED_ENTITLEMENT')
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'assessment' })
        await expect(save(0, 'assessment-fixed', 7000)).rejects.toThrow('FIXED_ENTITLEMENT')
        expect(await ds.getRepository(HostingCreditAllowanceChangeEntity).count()).toBe(0)
    })
    it('funds twelve monthly execution periods and ignores retired AI allowance policy', async () => {
        const beforeAi = await grants()
        const retired = createHostedAiAllowance({ dataSource: ds })
        await expect(retired.save({ actor, input: { platformId: client.platformId, expectedRevision: 0, requestKey: 'retired', monthlyCredits: 99999 } })).rejects.toThrow('RETIRED_USE_CREDITS')
        expect(await grants()).toEqual(beforeAi)
        expect(await ds.getRepository(HostingAiAllowanceChangeEntity).count()).toBe(0)
        const binding = await training()
        const issued = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        expect(issued.filter(grant => grant.sourceKey.startsWith('training:') && grant.meter === 'execution')).toHaveLength(12)
        expect(issued.filter(grant => grant.sourceKey.startsWith('training:') && grant.meter === 'execution').every(grant => grant.amount === 10000n)).toBe(true)
        expect(issued.filter(grant => grant.sourceKey.startsWith('training:') && grant.meter === 'managed_ai').every(grant => grant.amount === 0n)).toBe(true)
        await createHostedTraining({ dataSource: ds }).activate(binding)
        expect(await ds.getRepository(HostingGrantEntity).countBy({ platformId: client.platformId })).toBe(issued.length)
    })
    it('changes current and future funded allowances without changing usage, held funds or dates', async () => {
        await training()
        const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'root', payer: 'managed' })
        const rootClaim = await ledger.claimExecution({ actor: client.actor, reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: client.actor, rootReservationId: root.id, key: 'call', maxCostMicroUsd: 15000n })
        const callClaim = await ledger.claimManagedCall({ actor: client.actor, reservationId: call.id })
        const oldGrants = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        await expect(save(0, 'below-committed', 9)).rejects.toThrow('BELOW_COMMITTED')
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(oldGrants)
        const result = await save(0, 'equal-committed', 10)
        expect(result.period).toMatchObject({ amount: '10', consumed: '1', reserved: '9', available: '0' })
        for (const grant of await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })) {
            const old = oldGrants.find(value => value.id === grant.id)!
            expect(grant.validFrom).toEqual(old.validFrom); expect(grant.validUntil).toEqual(old.validUntil)
            expect(grant.consumed).toEqual(old.consumed); expect(grant.reserved).toEqual(old.reserved)
            if (grant.sourceKey.startsWith('training:') && grant.meter === 'execution') expect(grant.amount).toBe(10n)
            else expect(grant.amount).toBe(old.amount)
        }
        await ledger.settleManagedCall({ platformId: client.platformId, reservationId: call.id, dispatchId: callClaim.dispatchId!, actualCostMicroUsd: 4500n })
        await ledger.finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
        expect((await read()).period).toMatchObject({ amount: '10', consumed: '3', reserved: '0', available: '7' })
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: call.id })).actualAmount).toBe(0n)
    })
    it('includes unresolved legacy supplier holds in the committed Credit floor and billing projection', async () => {
        await training()
        const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'legacy-root', payer: 'managed' })
        await ledger.claimExecution({ actor: client.actor, reservationId: root.id })
        const executionGrant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId })
        const oldGrant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: client.platformId, sourceKey: executionGrant.sourceKey, meter: 'managed_ai' })
        await ds.getRepository(HostingReservationEntity).insert({ id: apId(), platformId: client.platformId, projectId: client.projectId!, identityId: client.identityId, grantId: oldGrant.id, key: 'legacy-pending', kind: 'managed_ai', payer: 'managed', state: 'uncertain', rootReservationId: root.id, day: null, amount: 1500n, actualAmount: null, dispatchId: apId(), accountingVersion: null, legacyCreditGrantId: executionGrant.id, microUsdPerCredit: 500n })
        await expect(save(0, 'legacy-floor-low', 3)).rejects.toThrow('BELOW_COMMITTED')
        const result = await save(0, 'legacy-floor-equal', 4)
        expect(result.period).toMatchObject({ amount: '4', consumed: '1', reserved: '3', available: '0' })
        const billing = await createHostedBillingView({ dataSource: ds }).read(client.actor)
        expect(billing.meters.execution).toMatchObject({ amount: '4', consumed: '1', reserved: '3', available: '0' })
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: oldGrant.id })).amount).toBe(0n)
    })
    it('is CAS-safe, idempotent, append-only and restores the plan default without refilling usage', async () => {
        await training()
        await save(0, 'same', 7000)
        const before = await ds.getRepository(HostingLedgerEntity).count()
        await save(0, 'same', 7000)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(before)
        expect(await ds.getRepository(HostingCreditAllowanceChangeEntity).count()).toBe(1)
        await expect(save(1, 'same', 8000)).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        await expect(save(0, 'stale', 8000)).rejects.toThrow('REVISION_CONFLICT')
        const current = (await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId, meter: 'execution' })).find(grant => grant.sourceKey.endsWith(':0'))!
        await ds.getRepository(HostingGrantEntity).update({ id: current.id }, { consumed: 3n })
        const restored = await save(1, 'restore', null)
        expect(restored.period).toMatchObject({ amount: '10000', consumed: '3', available: '9997' })
        const change = await ds.getRepository(HostingCreditAllowanceChangeEntity).findOneByOrFail({ platformId: client.platformId, revision: 1 })
        expect(change.grantSnapshots).toHaveLength(12)
        await expect(ds.getRepository(HostingCreditAllowanceChangeEntity).update({ id: change.id }, { reason: 'rewrite' })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it('preserves refunded or expired grants and never changes access dates or account holds', async () => {
        const binding = await training()
        await createHostedTraining({ dataSource: ds }).revoke({ actor, enrollmentId: binding.enrollmentId })
        const before = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        const account = await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })
        await save(0, 'revoked-policy', 7000)
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(before)
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })).toEqual(account)
        expect((await read()).period).toBeNull()
    })
    it('rolls back an adjustment if any candidate execution grant lacks funding provenance', async () => {
        await training()
        await ds.getRepository(HostingGrantEntity).insert({ id: apId(), platformId: client.platformId, sourceKey: 'training:missing-evidence:0', meter: 'execution', amount: 123n, consumed: 0n, reserved: 0n, validFrom: new Date(), validUntil: new Date(Date.now() + 86400000) })
        const before = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        await expect(save(0, 'invalid-source', 6000)).rejects.toThrow('SOURCE_INVALID')
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(before)
        expect(await ds.getRepository(HostingCreditAllowanceChangeEntity).count()).toBe(0)
    })
    it.each([['starter', 10000n], ['team', 100000n], ['scale', 500000n]] as const)('binds funded %s to an exact fifteen-day grace without refilling on renewal failure', async (planId, amount) => {
        const stripe = await paid(planId); await stripe.recover()
        const grant = (await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId, meter: 'execution' })).find(value => value.sourceKey.startsWith('stripe:'))!
        expect(grant.amount).toBe(amount)
        const subscription = await createHostedSubscriptions({ dataSource: ds }).read({ actor, platformId: client.platformId })
        expect(subscription.origin).toBe('paid_default')
        expect(subscription.renewalDueAt).toBe(new Date(stripe.end * 1000).toISOString())
        const account = await tx.run({ dataSource: ds, fn: manager => tx.account({ manager, platformId: client.platformId }) })
        const cutoff = stripe.end * 1000 + 15 * 86400000
        expect(subscriptionAccountActive(account, new Date(cutoff - 1))).toBe(true)
        expect(subscriptionAccountActive(account, new Date(cutoff))).toBe(false)
        const before = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        supplier.snapshot.mockResolvedValue({ ...stripe.snapshot, period: null, issues: ['HOSTING_STRIPE_PAYMENT_REQUIRED'] })
        await stripe.recover()
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(before)
        if (planId === 'scale') await expect((await createHostedStripe({ dataSource: ds })).checkout(client.actor, 'scale')).rejects.toThrow('SALES_REVIEW_REQUIRED')
    })
    it('funds only verified paid periods and invoice replay never resets adjusted credits', async () => {
        const stripe = await paid(); await stripe.recover()
        const initial = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        const grant = initial.find(value => value.meter === 'execution' && value.sourceKey.startsWith('stripe:'))!
        expect(grant.amount).toBe(10000n)
        expect(initial.find(value => value.meter === 'managed_ai' && value.sourceKey.startsWith('stripe:'))?.amount).toBe(0n)
        await save(0, 'paid-custom', 12000)
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { consumed: 3n, reserved: 2n })
        await stripe.recover()
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: grant.id })).toMatchObject({ amount: 12000n, consumed: 3n, reserved: 2n })
        expect(await ds.getRepository(HostingStripePeriodEntity).countBy({ platformId: client.platformId })).toBe(1)
        const view = await createHostedBillingView({ dataSource: ds }).read(client.actor)
        expect(view.meters.execution).toMatchObject({ amount: '12000', consumed: '3', reserved: '2', available: '11995' })
        expect(view.limits.aiCredits).toBe(0)
        expect(view.plans.map(plan => [plan.id, plan.price?.amountMinor, plan.limits.users, plan.limits.executions])).toEqual([['starter', 9900, 10, 10000], ['team', 39900, 30, 100000], ['scale', 129900, 100, 500000]])
        supplier.snapshot.mockResolvedValue({ ...stripe.snapshot, charges: [{ id: 'ch_first', refunded: true, lost: false, holds: ['refunded'] }] })
        await stripe.recover()
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: grant.id })).revokedAt).not.toBeNull()
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })).billingHold).toBe(true)
    })
})
