import { apId } from '@activepieces/core-utils'
import { hostingCatalog, PlatformRole, UserIdentityProvider, UserStatus } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { createHostedAccess } from '../../src/app/hosting/hosting-access'
import { createHostedBillingView } from '../../src/app/hosting/hosting-billing-view'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { HostingManualAccountEntity, HostingManualTermEntity } from '../../src/app/hosting/hosting-manual-accounts-entities'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedStripe } from '../../src/app/hosting/hosting-stripe'
import { HostingStripeBindingEntity, HostingStripeCommandEntity, HostingStripePeriodEntity } from '../../src/app/hosting/hosting-stripe-entities'
import { readStripePolicy, stripeDigest } from '../../src/app/hosting/hosting-stripe-policy'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const remote = vi.hoisted(() => ({ create: vi.fn(), snapshot: vi.fn() }))
vi.mock('../../src/app/hosting/hosting-stripe-adapter', () => ({ createStripeAdapter: async () => remote }))
let ds: DataSource, operator: HostingActor, client: HostingActor, bindingId: string, checkoutId: string, start: number, end: number
const catalog = { version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_growth', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } }
const service = () => createHostedStripe({ dataSource: ds })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: UserIdentityProvider.EMAIL, verified: true, password: 'unused', firstName: 'Synthetic', lastName: 'Billing', tokenVersion: 'initial' })
    return id
}
function snapshot(planId: 'starter' | 'team' = 'starter', periodStart = start, periodEnd = end) {
    const suffix = periodStart === start ? 'original' : 'renewal'
    return { customerPlatformId: client.platformId, subscriptionPlatformId: client.platformId, subscriptionId: 'sub_synthetic', subscriptionStatus: 'active', commandId: checkoutId, selectedPlanId: planId, planChangeCommandId: null, pendingPlan: null, cancelAtPeriodEnd: false, period: { subscriptionId: 'sub_synthetic', itemId: 'si_synthetic', priceId: catalog.plans[planId].priceId, planId, start: periodStart, end: periodEnd, invoiceId: `in_${suffix}`, lineId: `il_${suffix}`, chargeId: `ch_${suffix}` }, charges: [{ id: `ch_${suffix}`, refunded: false, lost: false, holds: [] }], issues: [] }
}
async function recover() {
    await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { reconcileAt: new Date(0) })
    await (await service()).recover()
}
async function funds() {
    return { account: await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId }), grants: await ds.getRepository(HostingGrantEntity).find({ where: { platformId: client.platformId }, order: { id: 'ASC' } }), ledger: await ds.getRepository(HostingLedgerEntity).find({ where: { platformId: client.platformId }, order: { id: 'ASC' } }), periods: await ds.getRepository(HostingStripePeriodEntity).find({ where: { platformId: client.platformId }, order: { id: 'ASC' } }) }
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
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_BILLING_MODE', 'stripe_test'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_test_synthetic'); vi.stubEnv('AP_HOSTED_STRIPE_WEBHOOK_SECRET', 'whsec_synthetic'); vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify(catalog))
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-plan-change-subject-at-least32characters' })
    const staffId = await identity(), home = await bootstrapHostedOperator(ds, onboarding, staffId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', staffId); operator = { identityId: staffId, platformId: home.platformId, tokenVersion: home.tokenVersion }
    const ownerId = await identity(), tenant = await onboarding.provision({ identityId: ownerId, name: 'Disposable paid client', operator })
    client = { identityId: ownerId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion }
    bindingId = apId(); checkoutId = apId(); start = Math.floor(Date.now() / 1000) - 60; end = start + 30 * 86400
    const payload = { customerId: 'cus_synthetic', planId: 'starter', catalogHash: readStripePolicy().hash }
    await ds.getRepository(HostingStripeCommandEntity).insert({ id: checkoutId, platformId: client.platformId, kind: 'checkout', state: 'closed', actorIdentityId: client.identityId, tokenVersion: client.tokenVersion, payload, payloadHash: stripeDigest(payload), idempotencyKey: apId(), firstSentAt: new Date() })
    await ds.getRepository(HostingStripeBindingEntity).insert({ id: bindingId, platformId: client.platformId, stripeAccountId: catalog.accountId, catalogHash: readStripePolicy().hash, customerId: 'cus_synthetic', subscriptionId: 'sub_synthetic', subscriptionStatus: 'active', holds: [], revision: 0, reconcileAt: new Date(0) })
    remote.create.mockReset().mockImplementation(async command => ({ objectId: 'sub_synthetic', url: null, expiresAt: new Date(String(command.payload.effectiveAt)) }))
    remote.snapshot.mockReset().mockResolvedValue(snapshot())
    await recover()
    const paid = (await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId, meter: 'execution' })).find(grant => grant.sourceKey.startsWith('stripe:'))!
    await ds.getRepository(HostingGrantEntity).update({ id: paid.id }, { consumed: 17n })
})
describe('client-owned renewal-only subscription changes', () => {
    it('does not replace the paid allowance, consumed Credits or ledger when scheduling another plan', async () => {
        const before = await funds(), result = await (await service()).changePlan(client, 'team')
        expect(result).toMatchObject({ planId: 'team', timing: 'next_renewal', effectiveAt: new Date(end * 1000).toISOString() })
        const after = await funds()
        expect(after.grants).toEqual(before.grants); expect(after.ledger).toEqual(before.ledger); expect(after.periods).toEqual(before.periods)
        expect(after.account.planId).toBe('starter'); expect(after.account.validUntil).toEqual(before.account.validUntil)
        expect(await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).toMatchObject({ pendingPlanId: 'team', pendingChangeAt: new Date(end * 1000) })
    })
    it('keeps old paid-plan evidence authoritative and grants the verified new paid cycle exactly once', async () => {
        await (await service()).changePlan(client, 'team')
        const change = await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ platformId: client.platformId, kind: 'plan_change' })
        remote.snapshot.mockResolvedValue({ ...snapshot(), selectedPlanId: 'team', planChangeCommandId: change.id, pendingPlan: { planId: 'team', effectiveAt: end, commandId: change.id } })
        const before = await funds(); await recover()
        expect((await funds()).grants).toEqual(before.grants); expect((await funds()).account.planId).toBe('starter')
        remote.snapshot.mockResolvedValue({ ...snapshot('team', end, end + 30 * 86400), planChangeCommandId: change.id })
        vi.spyOn(tx, 'now').mockResolvedValue(new Date((end + 60) * 1000))
        await recover(); await recover()
        const after = await funds(), paid = after.grants.filter(grant => grant.sourceKey.startsWith('stripe:') && grant.meter === 'execution')
        expect(after.account).toMatchObject({ planId: 'team', billingHold: false }); expect(after.periods).toHaveLength(2)
        expect(paid.map(grant => grant.amount).sort()).toEqual([10000n, 100000n])
        expect(paid.find(grant => grant.validFrom.getTime() === start * 1000)?.consumed).toBe(17n)
        expect(paid.find(grant => grant.validFrom.getTime() === end * 1000)?.consumed).toBe(0n)
    })
    it('preserves an already-paid changed plan when scheduling a second future price change', async () => {
        await (await service()).changePlan(client, 'team')
        const first = await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ platformId: client.platformId, kind: 'plan_change' })
        remote.snapshot.mockResolvedValue({ ...snapshot('team', end, end + 30 * 86400), planChangeCommandId: first.id })
        vi.spyOn(tx, 'now').mockResolvedValue(new Date((end + 60) * 1000)); await recover()
        expect((await funds()).account).toMatchObject({ planId: 'team', billingHold: false })
        await (await service()).changePlan(client, 'starter')
        const second = (await ds.getRepository(HostingStripeCommandEntity).findBy({ platformId: client.platformId, kind: 'plan_change' })).find(value => value.id !== first.id)!
        const before = await funds()
        remote.snapshot.mockResolvedValue({ ...snapshot('team', end, end + 30 * 86400), selectedPlanId: 'starter', planChangeCommandId: second.id, pendingPlan: { planId: 'starter', effectiveAt: end + 30 * 86400, commandId: second.id } })
        await recover()
        expect((await funds()).grants).toEqual(before.grants)
        expect((await funds()).account).toMatchObject({ planId: 'team', billingHold: false })
        expect(await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).toMatchObject({ pendingPlanId: 'starter', holds: [], lastError: null })
    })
    it('can first reconcile an unknown target after its paid renewal without resending or duplicate funding', async () => {
        remote.create.mockRejectedValueOnce(new Error('response lost'))
        await expect((await service()).changePlan(client, 'team')).rejects.toThrow('OUTCOME_UNKNOWN')
        const change = await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ platformId: client.platformId, kind: 'plan_change' })
        remote.snapshot.mockResolvedValue({ ...snapshot('team', end, end + 30 * 86400), planChangeCommandId: change.id })
        vi.spyOn(tx, 'now').mockResolvedValue(new Date((end + 60) * 1000)); await recover(); await recover()
        expect(await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id: change.id })).toMatchObject({ state: 'closed' })
        expect((await funds()).account).toMatchObject({ planId: 'team', billingHold: false })
        expect((await funds()).periods).toHaveLength(2)
        expect((await funds()).grants.filter(value => value.sourceKey.startsWith('stripe:') && value.meter === 'execution')).toHaveLength(2)
        expect(remote.create).toHaveBeenCalledTimes(1)
    })
    it('does not fund an unbound target invoice or failed renewal', async () => {
        const before = await funds()
        remote.snapshot.mockResolvedValue({ ...snapshot('team', end, end + 30 * 86400), planChangeCommandId: 'unknown-command' })
        vi.spyOn(tx, 'now').mockResolvedValue(new Date((end + 60) * 1000))
        await recover()
        expect((await funds()).grants).toEqual(before.grants)
        expect(await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).toMatchObject({ lastError: 'HOSTING_STRIPE_SUBSCRIPTION_UNBOUND' })
        remote.snapshot.mockResolvedValue({ ...snapshot(), period: null, issues: ['HOSTING_STRIPE_PAYMENT_REQUIRED'] })
        await recover()
        expect((await funds()).grants).toEqual(before.grants)
        expect((await funds()).periods).toEqual(before.periods)
    })
    it('recovers an unknown change only from the exact bound subscription metadata without another provider write', async () => {
        remote.create.mockRejectedValueOnce(new Error('response lost'))
        await expect((await service()).changePlan(client, 'team')).rejects.toThrow('OUTCOME_UNKNOWN')
        const change = await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ platformId: client.platformId, kind: 'plan_change' })
        const before = await funds()
        remote.snapshot.mockResolvedValue({ ...snapshot(), selectedPlanId: 'team', planChangeCommandId: change.id, pendingPlan: { planId: 'team', effectiveAt: end, commandId: change.id } })
        await recover()
        expect(await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id: change.id })).toMatchObject({ state: 'closed' })
        await (await service()).changePlan(client, 'team')
        expect(remote.create).toHaveBeenCalledTimes(1)
        expect((await funds()).grants).toEqual(before.grants); expect((await funds()).ledger).toEqual(before.ledger)
    })
    it('recovers a switch back to the current plan even when no pending plan remains', async () => {
        await (await service()).changePlan(client, 'team')
        remote.create.mockRejectedValueOnce(new Error('response lost'))
        await expect((await service()).changePlan(client, 'starter')).rejects.toThrow('OUTCOME_UNKNOWN')
        const changes = await ds.getRepository(HostingStripeCommandEntity).findBy({ platformId: client.platformId, kind: 'plan_change' })
        const uncertain = changes.find(change => change.state === 'uncertain')!
        remote.snapshot.mockResolvedValue({ ...snapshot(), selectedPlanId: 'starter', planChangeCommandId: uncertain.id, pendingPlan: null })
        const before = await funds(); await recover()
        expect(await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id: uncertain.id })).toMatchObject({ state: 'closed' })
        expect(await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).toMatchObject({ pendingPlanId: null, pendingChangeAt: null })
        await (await service()).changePlan(client, 'starter')
        expect(remote.create).toHaveBeenCalledTimes(2)
        expect((await funds()).grants).toEqual(before.grants)
    })
    it.each([{ cancelAtPeriodEnd: true }, { holds: ['review'] }, { subscriptionStatus: 'past_due' }])('refuses an unfit subscription before any price change', async delta => {
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, delta)
        await expect((await service()).changePlan(client, 'team')).rejects.toThrow('PLAN_CHANGE_UNSUPPORTED')
        expect(remote.create).not.toHaveBeenCalled()
    })
    it('does not replay a settled same-target command as a second provider mutation', async () => {
        await (await service()).changePlan(client, 'team'); await (await service()).changePlan(client, 'team')
        expect(remote.create).toHaveBeenCalledTimes(1)
    })
    it('retains uncertain changes and rejects conflicting targets without minting or blindly resending', async () => {
        const before = await funds(); remote.create.mockRejectedValueOnce(new Error('socket closed after send'))
        await expect((await service()).changePlan(client, 'team')).rejects.toThrow('OUTCOME_UNKNOWN')
        await expect((await service()).changePlan(client, 'starter')).rejects.toThrow(/CONFLICT|RECONCILIATION_REQUIRED/)
        await expect((await service()).changePlan(client, 'team')).rejects.toThrow('RECONCILIATION_REQUIRED')
        expect(remote.create).toHaveBeenCalledTimes(1)
        expect((await funds()).grants).toEqual(before.grants); expect((await funds()).ledger).toEqual(before.ledger)
    })
    it('rejects a target outside the fixed catalogue and Scale self-service without provider writes', async () => {
        await expect((await service()).changePlan(client, 'enterprise' as never)).rejects.toThrow('PRICE_DENIED')
        await expect((await service()).changePlan(client, 'scale')).rejects.toThrow('SALES_REVIEW_REQUIRED')
        expect(remote.create).not.toHaveBeenCalled()
    })
    it('requires explicit review before moving an account with manual funding into Stripe', async () => {
        const termId = apId()
        await ds.getRepository(HostingManualTermEntity).insert({ id: termId, platformId: client.platformId, identityId: client.identityId, planId: 'starter', revision: 1, startsAt: new Date(start * 1000), expiresAt: new Date(end * 1000), monthlyCredits: 10000, operatorIdentityId: operator.identityId, reason: 'Synthetic manual funding boundary' })
        await ds.getRepository(HostingManualAccountEntity).insert({ id: client.platformId, identityId: client.identityId, kind: 'client', package: null, termId, revision: 1 })
        await expect((await service()).changePlan(client, 'team')).rejects.toThrow('MANUAL_FUNDING_REQUIRES_REVIEW')
        await expect((await service()).portal(client)).rejects.toThrow('MANUAL_FUNDING_REQUIRES_REVIEW')
        expect(remote.create).not.toHaveBeenCalled()
    })
    it('rejects a downgrade below occupied customer seats, before changing Stripe or allowance', async () => {
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'team' })
        await ds.getRepository(HostingStripePeriodEntity).update({ platformId: client.platformId }, { planId: 'team', priceId: 'price_growth' })
        for (let index = 0; index < 10; index++) {
            const identityId = await identity()
            await ds.getRepository(UserEntity).insert({ id: apId(), identityId, platformId: client.platformId, status: UserStatus.ACTIVE, platformRole: PlatformRole.MEMBER })
        }
        const before = await funds()
        await expect((await service()).changePlan(client, 'starter')).rejects.toThrow('PLAN_RESOURCE_LIMIT')
        expect(remote.create).not.toHaveBeenCalled(); expect((await funds()).grants).toEqual(before.grants)
    })
    it.each(['member', 'assigned_partner', 'configured_operator'] as const)('denies %s customer billing reads and mutation sessions', async kind => {
        const identityId = kind === 'configured_operator' ? operator.identityId : await identity()
        let actor: HostingActor = { identityId, platformId: client.platformId, tokenVersion: kind === 'configured_operator' ? operator.tokenVersion : 'initial' }
        if (kind === 'assigned_partner') {
            const access = createHostedAccess({ dataSource: ds })
            await access.setRole({ actor: operator, identityId, role: 'partner', active: true })
            await access.assignPartner({ actor: operator, identityId, platformId: client.platformId })
            actor = { ...actor, tokenVersion: (await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })).tokenVersion }
            expect(await ds.getRepository(UserEntity).findOneByOrFail({ identityId, platformId: client.platformId })).toMatchObject({ platformRole: PlatformRole.ADMIN })
        }
        else await ds.getRepository(UserEntity).insert({ id: apId(), identityId, platformId: client.platformId, status: UserStatus.ACTIVE, platformRole: kind === 'member' ? PlatformRole.MEMBER : PlatformRole.ADMIN })
        await expect(createHostedBillingView({ dataSource: ds }).read(actor)).rejects.toThrow(/ACCESS_DENIED|CUSTOMER_BILLING_REQUIRED/)
        const stripe = await service()
        for (const action of [() => stripe.status(actor), () => stripe.checkout(actor, 'starter'), () => stripe.portal(actor), () => stripe.changePlan(actor, 'team')]) await expect(action()).rejects.toThrow(/ACCESS_DENIED|CUSTOMER_BILLING_REQUIRED/)
        expect(remote.create).not.toHaveBeenCalled()
    })
})
