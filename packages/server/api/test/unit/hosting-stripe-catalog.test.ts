import { apId } from '@activepieces/core-utils'
import { hostingCatalog } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingGrantEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedStripe } from '../../src/app/hosting/hosting-stripe'
import { createHostedStripeCatalog } from '../../src/app/hosting/hosting-stripe-catalog'
import { HostingStripeBindingEntity, HostingStripeCatalogChangeEntity, HostingStripeCatalogPreviewEntity, HostingStripeCommandEntity, HostingStripeInboxEntity, HostingStripePeriodEntity } from '../../src/app/hosting/hosting-stripe-entities'
import { readStripePolicy, stripeDigest } from '../../src/app/hosting/hosting-stripe-policy'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const remote = vi.hoisted(() => ({ catalogEvidence: vi.fn(), catalogCommandEvidence: vi.fn(), snapshot: vi.fn() }))
vi.mock('../../src/app/hosting/hosting-stripe-adapter', () => ({ createStripeAdapter: async () => remote }))
let ds: DataSource, actor: HostingActor, client: { platformId: string, actor: HostingActor }, bindingId: string
const service = () => createHostedStripeCatalog({ dataSource: ds })
const preview = () => service().preview({ actor, platformId: client.platformId })
const confirm = (previewId: string, requestKey = 'confirm-1') => service().confirm({ actor, input: { platformId: client.platformId, previewId, requestKey, reason: 'Adopt reviewed current credit catalog' } })
const catalog = () => ({ version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: { starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' }, team: { priceId: 'price_growth', amountMinor: 39900, currency: 'usd' }, scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' } } })
const emptyEvidence = () => ({ customerPlatformId: client.platformId, subscriptionPlatformId: null, subscriptionId: null, subscriptionStatus: null, commandId: null, period: null, charges: [], issues: [] })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', verified: true, password: 'unused', firstName: 'Catalog', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
beforeAll(async () => { ds = await migratedHostedPGlite() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_BILLING_MODE', 'stripe_test')
    vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_test_synthetic'); vi.stubEnv('AP_HOSTED_STRIPE_WEBHOOK_SECRET', 'whsec_synthetic'); vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify(catalog()))
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-catalog-subject-at-least32characters' })
    const id = await identity(), home = await bootstrapHostedOperator(ds, onboarding, id)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', id)
    actor = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }
    const identityId = await identity(), tenant = await onboarding.provision({ identityId, name: 'Catalog Client', operator: actor })
    client = { platformId: tenant.platformId, actor: { identityId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion } }
    bindingId = apId()
    await ds.getRepository(HostingStripeBindingEntity).insert({ id: bindingId, platformId: client.platformId, stripeAccountId: 'acct_synthetic', catalogHash: 'a'.repeat(64), customerId: 'cus_synthetic', holds: ['existing_safety_hold'], revision: 7, reconcileAt: new Date(0) })
    remote.catalogEvidence.mockReset().mockResolvedValue(emptyEvidence())
    remote.snapshot.mockReset().mockResolvedValue(emptyEvidence())
    remote.catalogCommandEvidence.mockReset().mockImplementation(async commands => {
        if (commands.some((row: { kind: string, state: string }) => row.state !== 'closed' && !(row.kind === 'customer' && row.state === 'ready'))) throw new Error('HOSTING_STRIPE_CATALOG_OPEN_COMMANDS')
        return []
    })
})
describe('explicit Stripe catalog-only migration', () => {
    it('keeps manual pilot billing usable without reading Stripe secrets or making provider calls', async () => {
        vi.stubEnv('AP_HOSTED_BILLING_MODE', 'manual'); vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', '')
        expect(await service().read({ actor, platformId: client.platformId })).toMatchObject({ mode: 'manual', state: 'manual' })
        await expect(preview()).rejects.toThrow('TEST_CONFIGURATION_REQUIRED')
        expect(remote.catalogEvidence).not.toHaveBeenCalled()
    })
    it('requires current platform operator authority for cross-tenant reads and writes', async () => {
        await expect(service().read({ actor: client.actor, platformId: client.platformId })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(service().preview({ actor: { ...actor, tokenVersion: 'old' }, platformId: client.platformId })).rejects.toThrow('OPERATOR_REQUIRED')
        expect(remote.catalogEvidence).not.toHaveBeenCalled()
    })
    it('migrates once, preserves funds and holds, and supports normal reconciliation afterward', async () => {
        const grants = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId }), ledger = await ds.getRepository(HostingLedgerEntity).findBy({ platformId: client.platformId })
        const p = await preview(), result = await confirm(p.previewId)
        expect(result).toMatchObject({ revision: 8, replayed: false })
        expect(await confirm(p.previewId)).toEqual({ ...result, replayed: true })
        expect(await ds.getRepository(HostingStripeCatalogChangeEntity).count()).toBe(1)
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(grants)
        expect(await ds.getRepository(HostingLedgerEntity).findBy({ platformId: client.platformId })).toEqual(ledger)
        expect(await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).toMatchObject({ catalogHash: readStripePolicy().hash, holds: ['existing_safety_hold'] })
        expect(await service().read({ actor, platformId: client.platformId })).toMatchObject({ state: 'current' })
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { reconcileAt: new Date(0) })
        await (await createHostedStripe({ dataSource: ds })).recover()
        expect(remote.snapshot).toHaveBeenCalled()
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(grants)
    })
    it('retains an existing paid subscription period and never issues its Credits twice after migration', async () => {
        const commandId = apId(), start = Math.floor(Date.now() / 1000) - 60, end = start + 30 * 86400
        await ds.getRepository(HostingStripeCommandEntity).insert({ id: commandId, platformId: client.platformId, kind: 'checkout', state: 'closed', actorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion, payload: { customerId: 'cus_synthetic', planId: 'starter' }, payloadHash: 'synthetic', idempotencyKey: apId() })
        const evidence = { ...emptyEvidence(), subscriptionPlatformId: client.platformId, subscriptionId: 'sub_synthetic', subscriptionStatus: 'active', commandId, period: { subscriptionId: 'sub_synthetic', itemId: 'si_synthetic', priceId: 'price_starter', planId: 'starter', start, end, invoiceId: 'in_paid', lineId: 'il_paid', chargeId: 'ch_paid' }, charges: [{ id: 'ch_paid', refunded: false, lost: false, holds: [] }] }
        remote.snapshot.mockResolvedValue(evidence); remote.catalogEvidence.mockResolvedValue(evidence)
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { catalogHash: readStripePolicy().hash, holds: [], reconcileAt: new Date(0) })
        await (await createHostedStripe({ dataSource: ds })).recover()
        const periods = await ds.getRepository(HostingStripePeriodEntity).findBy({ platformId: client.platformId }), grants = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId }), ledger = await ds.getRepository(HostingLedgerEntity).findBy({ platformId: client.platformId })
        expect(periods).toHaveLength(1)
        expect(grants.find(row => row.meter === 'execution' && row.sourceKey.startsWith('stripe:'))?.amount).toBe(30000n)
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { catalogHash: 'a'.repeat(64) })
        const p = await preview(); await confirm(p.previewId)
        await (await createHostedStripe({ dataSource: ds })).recover()
        expect(await ds.getRepository(HostingStripePeriodEntity).findBy({ platformId: client.platformId })).toEqual(periods)
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(grants)
        expect(await ds.getRepository(HostingLedgerEntity).findBy({ platformId: client.platformId })).toEqual(ledger)
    })
    it('recovers a checkout completed during an obsolete catalog and funds it exactly once through normal reconciliation', async () => {
        const commandId = apId(), payload = { customerId: 'cus_synthetic', planId: 'starter' }, start = Math.floor(Date.now() / 1000) - 60, end = start + 30 * 86400
        await ds.getRepository(HostingStripeCommandEntity).insert({ id: commandId, platformId: client.platformId, kind: 'checkout', state: 'ready', actorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion, payload, payloadHash: stripeDigest(payload), idempotencyKey: apId(), firstSentAt: new Date(), objectId: 'cs_completed' })
        const evidence = { ...emptyEvidence(), subscriptionPlatformId: client.platformId, subscriptionId: 'sub_latepaid', subscriptionStatus: 'active', commandId, period: { subscriptionId: 'sub_latepaid', itemId: 'si_latepaid', priceId: 'price_starter', planId: 'starter', start, end, invoiceId: 'in_latepaid', lineId: 'il_latepaid', chargeId: 'ch_latepaid' }, charges: [{ id: 'ch_latepaid', refunded: false, lost: false, holds: [] }] }
        remote.catalogEvidence.mockResolvedValue(evidence); remote.snapshot.mockResolvedValue(evidence)
        remote.catalogCommandEvidence.mockResolvedValue([{ commandId, objectId: 'cs_completed', reason: 'checkout_completed' }])
        const p = await preview(); await confirm(p.previewId)
        expect((await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).subscriptionId).toBeNull()
        expect(await ds.getRepository(HostingStripePeriodEntity).count()).toBe(0)
        const stripe = await createHostedStripe({ dataSource: ds }); await stripe.recover()
        expect(await ds.getRepository(HostingStripePeriodEntity).count()).toBe(1)
        expect((await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).subscriptionId).toBe('sub_latepaid')
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { reconcileAt: new Date(0) }); await stripe.recover()
        expect(await ds.getRepository(HostingStripePeriodEntity).count()).toBe(1)
    })
    it('rejects changed reasons, cross-preview replay and immutable history edits', async () => {
        const p = await preview(); await confirm(p.previewId)
        await expect(service().confirm({ actor, input: { platformId: client.platformId, previewId: p.previewId, requestKey: 'confirm-1', reason: 'Different reason' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        const receipt = await ds.getRepository(HostingStripeCatalogChangeEntity).findOneByOrFail({ previewId: p.previewId })
        await expect(ds.getRepository(HostingStripeCatalogChangeEntity).update({ id: receipt.id }, { reason: 'Rewrite' })).rejects.toThrow('HISTORY_IMMUTABLE')
        await expect(ds.getRepository(HostingStripeCatalogPreviewEntity).delete({ id: p.previewId })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it.each(['prepared', 'running', 'uncertain', 'ready'] as const)('blocks %s checkout or portal commands even when local TTL elapsed', async state => {
        await ds.getRepository(HostingStripeCommandEntity).insert({ id: apId(), platformId: client.platformId, kind: 'portal', state, actorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion, payload: {}, payloadHash: 'old', idempotencyKey: apId(), expiresAt: new Date(0), leaseUntil: new Date(0) })
        await expect(preview()).rejects.toThrow('OPEN_COMMANDS')
    })
    it('retires only remotely proven checkout and ready portal delivery bookkeeping, with an idempotent receipt', async () => {
        const checkoutId = apId(), portalId = apId()
        for (const [id, kind, objectId] of [[checkoutId, 'checkout', 'cs_expired'], [portalId, 'portal', 'bps_ready']]) await ds.getRepository(HostingStripeCommandEntity).insert({ id, platformId: client.platformId, kind: kind as 'checkout' | 'portal', state: 'ready', actorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion, payload: { customerId: 'cus_synthetic' }, payloadHash: 'synthetic', idempotencyKey: apId(), firstSentAt: new Date(), objectId })
        remote.catalogCommandEvidence.mockResolvedValue([{ commandId: checkoutId, objectId: 'cs_expired', reason: 'checkout_expired' }, { commandId: portalId, objectId: 'bps_ready', reason: 'portal_delivery_retired' }])
        const p = await preview()
        expect(p.retiringCommands).toHaveLength(2)
        await confirm(p.previewId); expect((await confirm(p.previewId)).replayed).toBe(true)
        for (const id of [checkoutId, portalId]) expect(await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id })).toMatchObject({ state: 'closed', payloadHash: 'synthetic' })
        expect(await ds.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id: portalId })).toMatchObject({ objectId: 'bps_ready' })
    })
    it('retires an expired reconciliation fence while an active lease remains blocked', async () => {
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { fence: 'old-fence', leaseUntil: new Date(Date.now() + 60_000) })
        await expect(preview()).rejects.toThrow('RECONCILIATION_BUSY')
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { leaseUntil: new Date(0) })
        const p = await preview(); expect(p.retiringExpiredLease).toBe(true)
        await confirm(p.previewId)
        const after = await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })
        expect(after).toMatchObject({ fence: null, leaseUntil: null })
        // A late old reconciliation receipt cannot meet its saved fence/revision.
        expect(after.fence).not.toBe('old-fence'); expect(after.revision).not.toBe(7)
    })
    it('rejects a late receipt from an expired pre-migration reconciliation worker', async () => {
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { catalogHash: readStripePolicy().hash, reconcileAt: new Date(0) })
        let finish!: (value: ReturnType<typeof emptyEvidence>) => void, claimed!: () => void
        const started = new Promise<void>(resolve => { claimed = resolve })
        remote.snapshot.mockImplementationOnce(() => { claimed(); return new Promise(resolve => { finish = resolve }) })
        const oldWorker = await createHostedStripe({ dataSource: ds }), work = oldWorker.recover()
        await started
        vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify({ ...catalog(), origin: 'http://127.0.0.1' }))
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { leaseUntil: new Date(0) })
        try {
            const p = await preview(); await confirm(p.previewId)
        } finally {
            finish(emptyEvidence()); await work
        }
        const bound = await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })
        expect(bound).toMatchObject({ catalogHash: readStripePolicy().hash, fence: null, leaseUntil: null, holds: ['existing_safety_hold'] })
        expect(await ds.getRepository(HostingStripePeriodEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingStripeCatalogChangeEntity).count()).toBe(1)
    })
    it('refuses a five-minute preview after expiry', async () => {
        const p = await preview(), clock = vi.spyOn(tx, 'now').mockResolvedValue(new Date(Date.now() + 6 * 60_000))
        try { await expect(confirm(p.previewId)).rejects.toThrow('PREVIEW_EXPIRED') } finally { clock.mockRestore() }
    })
    it('blocks cross-account mapping and unsupported subscription evidence', async () => {
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { stripeAccountId: 'acct_other' })
        await expect(preview()).rejects.toThrow('ACCOUNT_MISMATCH')
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { stripeAccountId: 'acct_synthetic' })
        remote.catalogEvidence.mockResolvedValue({ ...emptyEvidence(), issues: ['HOSTING_STRIPE_PRICE_DENIED'] })
        await expect(preview()).rejects.toThrow('PRICE_DENIED')
    })
    it('rejects a preview after local webhook/reconciliation or provider state changes', async () => {
        const p = await preview()
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { revision: 8 })
        await expect(confirm(p.previewId)).rejects.toThrow('PREVIEW_STALE')
        await ds.getRepository(HostingStripeBindingEntity).update({ id: bindingId }, { revision: 7 })
        const fresh = await preview()
        remote.catalogEvidence.mockResolvedValue({ ...emptyEvidence(), charges: [{ id: 'ch_changed', refunded: true, lost: false, holds: [] }] })
        await expect(confirm(fresh.previewId)).rejects.toThrow('PROVIDER_CHANGED')
        expect(await ds.getRepository(HostingStripeCatalogChangeEntity).count()).toBe(0)
    })
    it('rejects authority revoked during the remote check and a changed target policy', async () => {
        const p = await preview()
        remote.catalogEvidence.mockImplementation(async () => { await ds.getRepository(UserIdentityEntity).update({ id: actor.identityId }, { tokenVersion: 'revoked' }); return emptyEvidence() })
        await expect(confirm(p.previewId)).rejects.toThrow('OPERATOR_REQUIRED')
        await ds.getRepository(UserIdentityEntity).update({ id: actor.identityId }, { tokenVersion: actor.tokenVersion })
        vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify({ ...catalog(), origin: 'http://127.0.0.1' }))
        await expect(confirm(p.previewId)).rejects.toThrow('PREVIEW_STALE')
    })
    it('binds the exact customer tenant and preserves pending refund events for reconciliation', async () => {
        remote.catalogEvidence.mockResolvedValue({ ...emptyEvidence(), customerPlatformId: actor.platformId })
        await expect(preview()).rejects.toThrow('CUSTOMER_CONFLICT')
        remote.catalogEvidence.mockResolvedValue(emptyEvidence())
        await ds.getRepository(HostingStripeInboxEntity).insert({ id: apId(), stripeAccountId: 'acct_synthetic', eventId: 'evt_pending', eventType: 'charge.refunded', rawHash: 'synthetic', eventHash: 'synthetic', customerId: 'cus_synthetic', risk: true, state: 'pending', availableAt: new Date() })
        const p = await preview(); await confirm(p.previewId)
        expect((await ds.getRepository(HostingStripeInboxEntity).findOneByOrFail({ eventId: 'evt_pending' })).state).toBe('pending')
        expect((await ds.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: bindingId })).holds).toEqual(['existing_safety_hold'])
    })
})
