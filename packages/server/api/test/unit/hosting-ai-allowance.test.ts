import { apId } from '@activepieces/core-utils'
import { hostingCatalog } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAiAllowanceChangeEntity } from '../../src/app/hosting/hosting-ai-allowance-entities'
import { createHostedAiAllowance } from '../../src/app/hosting/hosting-ai-allowance'
import { createHostedBillingView } from '../../src/app/hosting/hosting-billing-view'
import { HostingAccountEntity, HostingDailyBudgetEntity, HostingGrantEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedStripe } from '../../src/app/hosting/hosting-stripe'
import { HostingStripeBindingEntity, HostingStripeCommandEntity, HostingStripePeriodEntity } from '../../src/app/hosting/hosting-stripe-entities'
import { readStripePolicy } from '../../src/app/hosting/hosting-stripe-policy'
import { createHostedTraining } from '../../src/app/hosting/hosting-training'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const supplier = vi.hoisted(() => ({ snapshot: vi.fn() }))
// Only the external Stripe transport is synthetic. Reconciliation, paid-period
// creation, idempotence, revocation and allowance authority are real services.
vi.mock('../../src/app/hosting/hosting-stripe-adapter', () => ({ createStripeAdapter: async () => ({ snapshot: supplier.snapshot }) }))
let ds: DataSource, actor: HostingActor, client: Awaited<ReturnType<typeof makeClient>>
const allowance = () => createHostedAiAllowance({ dataSource: ds })
const read = () => allowance().read({ actor, platformId: client.platformId })
const save = (revision: number, key: string, monthlyCredits: number | null) => allowance().save({ actor, input: { platformId: client.platformId, expectedRevision: revision, requestKey: key, monthlyCredits } })
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
    await createHostedTraining({ dataSource: ds }).activate(binding)
    return binding
}
async function paid() {
    vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_test_synthetic')
    vi.stubEnv('AP_HOSTED_STRIPE_WEBHOOK_SECRET', 'whsec_synthetic')
    vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify({ version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: { starter: { priceId: 'price_starter', amountMinor: 1000, currency: 'usd' }, team: { priceId: 'price_team', amountMinor: 2000, currency: 'usd' } } }))
    const policy = readStripePolicy(), bindingId = apId(), commandId = apId(), now = Math.floor(Date.now() / 1000), end = now + 30 * 86400
    await ds.getRepository(HostingStripeBindingEntity).insert({ id: bindingId, platformId: client.platformId, stripeAccountId: policy.catalog.accountId, catalogHash: policy.hash, customerId: 'cus_synthetic', holds: [], revision: 0, reconcileAt: new Date(0) })
    async function command(id: string, planId: 'starter' | 'team') {
        await ds.getRepository(HostingStripeCommandEntity).insert({ id, platformId: client.platformId, kind: 'checkout', state: 'closed', actorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion, payload: { customerId: 'cus_synthetic', planId }, payloadHash: 'synthetic', idempotencyKey: apId() })
    }
    await command(commandId, 'starter')
    const period = { subscriptionId: 'sub_synthetic', itemId: 'si_starter', priceId: 'price_starter', planId: 'starter' as const, start: now - 60, end, invoiceId: 'in_first', lineId: 'il_first', chargeId: 'ch_first' }
    const snapshot = { customerPlatformId: client.platformId, subscriptionPlatformId: client.platformId, subscriptionId: 'sub_synthetic', subscriptionStatus: 'active', commandId, period, charges: [] as { id: string, refunded: boolean, lost: boolean, holds: string[] }[], issues: [] }
    supplier.snapshot.mockResolvedValue(snapshot)
    const stripe = await createHostedStripe({ dataSource: ds })
    async function recover() {
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { reconcileAt: new Date(0) })
        await stripe.recover()
    }
    return { snapshot, period, recover, command, end }
}
beforeAll(async () => { ds = await migratedHostedPGlite() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })
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

describe('per-client managed AI allowance', () => {
    it('denies client ADMIN/stale operators and bounds inputs without changing policy', async () => {
        await expect(allowance().read({ actor: client.actor, platformId: client.platformId })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(allowance().save({ actor: client.actor, input: { platformId: client.platformId, expectedRevision: 0, requestKey: 'denied', monthlyCredits: 1000 } })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(allowance().read({ actor: { ...actor, tokenVersion: 'stale' }, platformId: client.platformId })).rejects.toThrow('OPERATOR_REQUIRED')
        for (const amount of [-1, 0.5, 1000001]) await expect(save(0, 'invalid', amount)).rejects.toThrow()
        expect(await ds.getRepository(HostingAiAllowanceChangeEntity).count()).toBe(0)
        expect(hostingCatalog.getPlan({ planId: 'training' }).aiCredits).toBe(5000)
        expect(hostingCatalog.getPlan({ planId: 'team' }).aiCredits).toBe(20000)
    })
    it('keeps the trial one-off grant intact and applies stored policy to actual future training issuance', async () => {
        const trial = (await grants())[0]
        const view = await save(0, 'trial-policy', 7000)
        expect(view).toMatchObject({ revision: 1, planId: 'trial', defaultMonthlyCredits: 5000, effectiveMonthlyCredits: 7000, appliesToCurrentPeriod: false, period: { amountMicroUsd: '1000000' } })
        expect((await grants())[0]).toEqual(trial)
        const binding = await training(), issued = (await grants()).filter(grant => grant.sourceKey.startsWith('training:'))
        expect(issued).toHaveLength(2)
        expect(issued.map(grant => grant.amount)).toEqual([7000000n, 7000000n])
        await createHostedTraining({ dataSource: ds }).activate(binding)
        expect((await grants()).filter(grant => grant.sourceKey.startsWith('training:'))).toEqual(issued)
    })
    it('preserves held liability on reduction, settles it normally and leaves global budget unchanged', async () => {
        await training()
        const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'root', payer: 'managed' })
        const rootClaim = await ledger.claimExecution({ actor: client.actor, reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: client.actor, rootReservationId: root.id, key: 'original', maxCostMicroUsd: 3000000n })
        const claim = await ledger.claimManagedCall({ actor: client.actor, reservationId: call.id }), budget = await ds.getRepository(HostingDailyBudgetEntity).find()
        const view = await save(0, 'below-held', 1000)
        expect(view.period).toMatchObject({ amountMicroUsd: '1000000', reservedMicroUsd: '3000000', consumedMicroUsd: '0', availableMicroUsd: '0' })
        expect(await ds.getRepository(HostingDailyBudgetEntity).find()).toEqual(budget)
        await expect(ledger.reserveManagedCall({ actor: client.actor, rootReservationId: root.id, key: 'denied-new', maxCostMicroUsd: 1n })).rejects.toThrow('CREDITS_EXHAUSTED')
        await ledger.settleManagedCall({ platformId: client.platformId, reservationId: call.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 2000000n })
        await ledger.finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
        expect((await read()).period).toMatchObject({ amountMicroUsd: '1000000', consumedMicroUsd: '2000000', reservedMicroUsd: '0', availableMicroUsd: '0' })
        const before = await ds.getRepository(HostingLedgerEntity).count()
        await save(0, 'below-held', 1000)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(before)
        await expect(save(0, 'below-held', 2000)).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        await expect(save(0, 'stale', 2000)).rejects.toThrow('REVISION_CONFLICT')
        const other = await makeClient()
        await expect(allowance().save({ actor, input: { platformId: other.platformId, expectedRevision: 0, requestKey: 'below-held', monthlyCredits: 1000 } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        const change = await ds.getRepository(HostingAiAllowanceChangeEntity).findOneByOrFail({ platformId: client.platformId, revision: 1 })
        expect(change.grantSnapshots).toHaveLength(2)
        await expect(ds.getRepository(HostingAiAllowanceChangeEntity).update({ id: change.id }, { reason: 'mutate' })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it('treats zero as a cap and null as restoration without changing period dates or grant count', async () => {
        await training()
        const before = (await grants()).map(grant => [grant.id, grant.validFrom, grant.validUntil])
        await save(0, 'zero', 0)
        expect((await grants()).filter(grant => grant.sourceKey.startsWith('training:')).every(grant => grant.amount === 0n)).toBe(true)
        expect((await read()).overrideMonthlyCredits).toBe(0)
        await save(1, 'inherit', null)
        expect((await grants()).filter(grant => grant.sourceKey.startsWith('training:')).every(grant => grant.amount === 5000000n)).toBe(true)
        expect((await grants()).map(grant => [grant.id, grant.validFrom, grant.validUntil])).toEqual(before)
    })
    it('funds new paid periods from policy and never resets an adjusted period on invoice replay', async () => {
        await save(0, 'paid-policy', 9000)
        const stripe = await paid()
        await stripe.recover()
        const paidGrant = (await grants()).find(grant => grant.sourceKey.startsWith('stripe:'))!
        expect(paidGrant.amount).toBe(9000000n)
        await save(1, 'paid-adjust', 12000)
        await ds.getRepository(HostingGrantEntity).update({ id: paidGrant.id }, { consumed: 100n, reserved: 200n })
        await stripe.recover()
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: paidGrant.id })).toMatchObject({ amount: 12000000n, consumed: 100n, reserved: 200n })
        expect(await ds.getRepository(HostingStripePeriodEntity).countBy({ platformId: client.platformId })).toBe(1)
        const commandId = apId()
        await stripe.command(commandId, 'team')
        supplier.snapshot.mockResolvedValue({ ...stripe.snapshot, commandId, period: { ...stripe.period, itemId: 'si_team', priceId: 'price_team', planId: 'team', start: stripe.end, end: stripe.end + 30 * 86400, invoiceId: 'in_team', lineId: 'il_team', chargeId: 'ch_team' } })
        await stripe.recover()
        expect((await grants()).filter(grant => grant.sourceKey.startsWith('stripe:')).map(grant => grant.amount)).toEqual([12000000n, 12000000n])
        await save(2, 'paid-inherit', null)
        expect((await grants()).filter(grant => grant.sourceKey.startsWith('stripe:')).map(grant => grant.amount)).toEqual([5000000n, 20000000n])
        expect((await createHostedBillingView({ dataSource: ds }).read(client.actor)).limits.aiCredits).toBe(5000)
    })
    it('never revives refunded grants, clears holds or changes grant amounts for an expired account', async () => {
        const stripe = await paid()
        await stripe.recover()
        const funded = (await grants()).find(grant => grant.sourceKey.startsWith('stripe:'))!
        supplier.snapshot.mockResolvedValue({ ...stripe.snapshot, charges: [{ id: 'ch_first', refunded: true, lost: false, holds: ['refunded'] }] })
        await stripe.recover()
        await save(0, 'after-refund', 8000)
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: funded.id })).toMatchObject({ amount: 5000000n, revokedAt: expect.any(Date) })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })).billingHold).toBe(true)
        expect((await read()).period).toBeNull()
        const other = await makeClient()
        client = other
        await training()
        const before = await grants()
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { validUntil: new Date(0) })
        const view = await save(0, 'expired-policy', 7000)
        expect(await grants()).toEqual(before)
        expect(view).toMatchObject({ effectiveMonthlyCredits: 7000, appliesToCurrentPeriod: false, period: { availableMicroUsd: '0' } })
    })
    it.each([{ billingHold: true }, { status: 'suspended' as const }, { validUntil: new Date(0) }])('shows zero spendable execution and AI allowance for blocked account %j', async patch => {
        await training()
        await save(0, 'visible-limit', 7000)
        const before = await grants()
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, patch)
        const overview = await createHostedBillingView({ dataSource: ds }).read(client.actor)
        expect(overview.meters.execution.available).toBe('0')
        expect(overview.meters.managedAi.available).toBe('0')
        expect(overview.limits.aiCredits).toBe(7000)
        expect((await read()).period?.availableMicroUsd).toBe('0')
        expect(await grants()).toEqual(before)
    })
    it('rolls back fully when a candidate grant lacks paid source evidence', async () => {
        await training()
        await ds.getRepository(HostingGrantEntity).insert({ id: apId(), platformId: client.platformId, sourceKey: 'stripe:missing-evidence', meter: 'managed_ai', amount: 123n, consumed: 0n, reserved: 0n, validFrom: new Date(), validUntil: new Date(Date.now() + 86400000) })
        const before = await grants()
        await expect(save(0, 'invalid-source', 6000)).rejects.toThrow('SOURCE_INVALID')
        expect(await grants()).toEqual(before)
        expect(await ds.getRepository(HostingAiAllowanceChangeEntity).count()).toBe(0)
    })
})
