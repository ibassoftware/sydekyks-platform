import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { apId } from '@activepieces/core-utils'
import { EngineResponseStatus, PrincipalType } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { accessTokenManager } from '../../src/app/authentication/lib/access-token-manager'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { authenticationMiddleware } from '../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { commonProperties } from '../../src/app/database/database-connection'
import { getMigrations } from '../../src/app/database/postgres-connection'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { createHostedAiGateway } from '../../src/app/hosting/hosting-ai-gateway'
import { ChargeResolutionDraftInput, createHostedChargeResolution } from '../../src/app/hosting/hosting-charge-resolution'
import { hostingChargeResolutionController } from '../../src/app/hosting/hosting-charge-resolution-controller'
import { HostingChargeResolutionEntity } from '../../src/app/hosting/hosting-charge-resolution-entities'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingDailyBudgetEntity, HostingGrantEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { createHostedExecution } from '../../src/app/hosting/hosting-execution'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { saveManagedSettings } from '../../src/app/hosting/hosting-managed-settings'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPricing, hostedPricingView } from '../../src/app/hosting/hosting-pricing'
import { PRICING_CALENDAR } from '../../src/app/hosting/hosting-pricing-source'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite, scopedAiActionPayload } from '../helpers/hosting-fixtures'

let ds: DataSource, app: FastifyInstance, previousConnection: unknown, actor: HostingActor, projectId: string
const pgMode = process.env['HOSTING_BILLING_TEST_POSTGRES'] === '1', schema = `hosting_charge_${randomBytes(6).toString('hex')}`
const service = () => createHostedChargeResolution({ dataSource: ds }), ledger = () => createHostedLedger({ dataSource: ds })
beforeAll(async () => {
    if (pgMode) {
        if (!process.env['HOSTING_TEST_POSTGRES_PORT']) throw new Error('Explicit disposable PostgreSQL target required')
        ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(process.env['HOSTING_TEST_POSTGRES_PORT']), username: process.env['HOSTING_TEST_POSTGRES_USER'], password: process.env['HOSTING_TEST_POSTGRES_PASSWORD'], database: process.env['HOSTING_TEST_POSTGRES_DATABASE'], schema, extra: { options: `-c search_path=${schema},public` }, migrations: getMigrations(), ...commonProperties })
        await ds.initialize(); await ds.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
        const runner = ds.createQueryRunner()
        try {
            await runner.createSchema(schema, true)
        }
        finally {
            await runner.release()
        }
        await ds.runMigrations({ transaction: 'each' })
    }
    else ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__'); Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
    app.addHook('preHandler', authenticationMiddleware); app.addHook('preHandler', authorizationMiddleware)
    await app.register(hostingChargeResolutionController, { prefix: '/charges' }); await app.ready()
})
afterAll(async () => {
    if (app) await app.close(); Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection); if (ds?.isInitialized) {
        if (pgMode) await ds.query(`DROP SCHEMA "${schema}" CASCADE`); await ds.destroy()
    }
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => pgMode ? `"${schema}"."${entity.tableName}"` : `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Charge', lastName: 'Operator', tokenVersion: 'original' })
    const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-charge-resolution-secret-atleast32' }), id)
    actor = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }; projectId = home.projectId!
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', id)
})
async function uncertain(payer: 'managed' | 'byok' = 'managed') {
    const root = await ledger().reserveExecution({ actor, projectId, key: apId(), payer }), rootClaim = await ledger().claimExecution({ actor, reservationId: root.id }), admissionId = apId(), segmentId = apId(), now = new Date()
    await ds.getRepository(HostingDispatchEntity).insert({ id: segmentId, platformId: actor.platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 'a'.repeat(64), state: 'uncertain', rootKey: apId(), reservationId: root.id, admissionId, dispatchId: rootClaim.dispatchId, completionStatus: EngineResponseStatus.INTERNAL_ERROR, leaseUntil: new Date(now.getTime() - 1000) })
    const reservation = payer === 'managed' ? await ledger().reserveManagedCall({ actor, rootReservationId: root.id, key: apId(), maxCostMicroUsd: 5000n }) : null
    const claim = reservation ? await ledger().claimManagedCall({ actor, reservationId: reservation.id }) : null
    if (reservation) await ledger().markUncertain({ platformId: actor.platformId, reservationId: reservation.id, dispatchId: claim!.dispatchId! })
    await ledger().markUncertain({ platformId: actor.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
    const call = await ds.getRepository(HostingModelCallEntity).save({ id: apId(), platformId: actor.platformId, projectId, segmentId, rootReservationId: root.id, admissionId, identityId: actor.identityId, callKey: 'test:0', attempt: 0, requestHash: 'b'.repeat(64), payer, configId: payer === 'byok' ? apId() : null, credentialFingerprint: 'c'.repeat(64), model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions', state: 'uncertain', reservationId: reservation?.id ?? null, dispatchId: claim?.dispatchId ?? null, fence: apId(), budgetDay: reservation?.day ?? null, quote: payer === 'managed' ? { version: 'fixture', model: 'deepseek-flash', validFrom: new Date(now.getTime() - 60000).toISOString(), validUntil: new Date(now.getTime() + 60000).toISOString(), rates: { cacheHit: 100000, cacheMiss: 200000, output: 400000 }, ceiling: { cacheHit: 100000, cacheMiss: 200000, output: 400000 } } : null, sentAt: now, leaseUntil: new Date(now.getTime() - 1000), inputTokenBound: 10000 })
    const draft: ChargeResolutionDraftInput = { platformId: actor.platformId, rootReservationId: root.id, outcome: 'confirmed_not_sent', reason: 'Investigated timed-out synthetic request', evidenceReference: 'Synthetic supplier audit confirms no request was received' }
    return { root, call, reservation, draft, segmentId }
}
async function command(callId: string, draft: ChargeResolutionDraftInput) {
    const preview = await service().preview({ actor, callId, input: draft })
    return { ...draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() }
}
it('releases definitively not-sent liability once, preserves base Credit, fences call and settles safe capacity', async () => {
    const fixture = await uncertain(), input = await command(fixture.call.id, fixture.draft)
    const first = await service().resolve({ actor, callId: fixture.call.id, input }), second = await service().resolve({ actor, callId: fixture.call.id, input })
    expect(first).toMatchObject({ replayed: false, view: { state: 'cancelled', heldCredits: '0', revision: 1 } }); expect(second).toMatchObject({ replayed: true, auditId: first.auditId })
    expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.reservation!.id })).state).toBe('released')
    expect((await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ id: fixture.call.id })).fence).not.toBe(fixture.call.fence)
    expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'execution' })).toMatchObject({ consumed: 1n, reserved: 0n })
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 0 })
    expect(await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: fixture.call.budgetDay! })).toMatchObject({ reserved: 0n, consumed: 0n })
    expect(await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ id: fixture.segmentId })).toMatchObject({ state: 'completed', resolutionStatus: 'FAILED', completionStatus: EngineResponseStatus.INTERNAL_ERROR, terminalReceipt: null })
    await expect(service().resolve({ actor, callId: fixture.call.id, input: { ...input, reason: 'Different requested refund justification' } })).rejects.toThrow('CONFLICT')
})
it('settles authoritative receipt at original v1 conversion even after grant expiry/revocation and tariff expiry', async () => {
    const fixture = await uncertain(), reservation = fixture.reservation!, grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId })
    await ds.getRepository(HostingReservationEntity).update({ id: reservation.id }, { accountingVersion: 'single-credits-500-microusd-v1', microUsdPerCredit: 500n, amount: 10n })
    await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { reserved: 10n, validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() - 1000), revokedAt: new Date() })
    const quote = fixture.call.quote!; quote.validUntil = new Date(fixture.call.sentAt!.getTime() + 1).toISOString()
    await ds.getRepository(HostingModelCallEntity).update({ id: fixture.call.id }, { quote })
    const draft = { ...fixture.draft, outcome: 'verified_usage' as const, supplierRequestId: 'receipt-synthetic-1', supplierCreatedAt: fixture.call.sentAt!.toISOString(), usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, completion_tokens: 1000 } }
    const input = await command(fixture.call.id, draft), result = await service().resolve({ actor, callId: fixture.call.id, input })
    expect(result.view).toMatchObject({ state: 'settled', heldCredits: '0' })
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: reservation.id })).toMatchObject({ actualSupplierMicroUsd: 600n, actualAmount: 2n })
    expect(await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: fixture.call.budgetDay! })).toMatchObject({ reserved: 0n, consumed: 600n })
    expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: grant.id })).toMatchObject({ consumed: 3n, reserved: 0n })
})
it('retains unknown liability, audits evidence immutably and rejects stale concurrent operator commands', async () => {
    const fixture = await uncertain(), draft = { ...fixture.draft, outcome: 'retain' as const }, first = await command(fixture.call.id, draft), second = await command(fixture.call.id, draft)
    await service().resolve({ actor, callId: fixture.call.id, input: first })
    await expect(service().resolve({ actor, callId: fixture.call.id, input: second })).rejects.toThrow('CONFLICT')
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.reservation!.id })).toMatchObject({ state: 'uncertain', amount: 20n })
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 1 })
    await expect(ds.getRepository(HostingChargeResolutionEntity).update({ callId: fixture.call.id }, { reason: 'Overwrite authoritative audit history' })).rejects.toThrow('IMMUTABLE')
})
it('blocks stale previews after supplier settlement and rejects attempts against another tenant/root', async () => {
    const fixture = await uncertain(), input = await command(fixture.call.id, fixture.draft)
    await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: fixture.reservation!.id, dispatchId: fixture.call.dispatchId!, actualCostMicroUsd: 1000n })
    await ds.getRepository(HostingModelCallEntity).update({ id: fixture.call.id }, { state: 'settled', actualMicroUsd: '1000' })
    await expect(service().resolve({ actor, callId: fixture.call.id, input })).rejects.toThrow('CONFLICT')
    await expect(service().preview({ actor, callId: fixture.call.id, input: { ...fixture.draft, rootReservationId: apId() } })).rejects.toThrow('NOT_FOUND')
    expect(await ds.getRepository(HostingChargeResolutionEntity).count()).toBe(0)
})
it.each(['live-call', 'live-segment', 'unconfirmed-segment'] as const)('keeps root capacity while %s remains', async kind => {
    const fixture = await uncertain()
    if (kind === 'live-call') await ds.getRepository(HostingModelCallEntity).insert({ ...fixture.call, id: apId(), callKey: 'sibling:1', state: 'running', reservationId: null, leaseUntil: new Date(Date.now() + 60000) })
    else await ds.getRepository(HostingDispatchEntity).update({ id: fixture.segmentId }, kind === 'live-segment' ? { leaseUntil: new Date(Date.now() + 60000) } : { completionStatus: null })
    const input = await command(fixture.call.id, fixture.draft)
    if (kind === 'live-call') await service().resolve({ actor, callId: fixture.call.id, input })
    else await expect(service().resolve({ actor, callId: fixture.call.id, input })).rejects.toThrow('UNSAFE')
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 1 })
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.root.id })).toMatchObject({ state: 'uncertain' })
})
it('resolves BYOK outcome without managed debit or supplier budget and closes its failed root', async () => {
    const fixture = await uncertain('byok'), input = await command(fixture.call.id, fixture.draft)
    await service().resolve({ actor, callId: fixture.call.id, input })
    expect(await ds.getRepository(HostingDailyBudgetEntity).count()).toBe(0)
    expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'execution' })).toMatchObject({ consumed: 1n, reserved: 0n })
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 0 })
})
it.each(['session', 'allowlist', 'live-call'] as const)('rejects resolution after %s changes', async kind => {
    const fixture = await uncertain(), input = await command(fixture.call.id, fixture.draft)
    if (kind === 'session') await ds.getRepository(UserIdentityEntity).update({ id: actor.identityId }, { tokenVersion: 'revoked' })
    if (kind === 'allowlist') vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    if (kind === 'live-call') await ds.getRepository(HostingModelCallEntity).update({ id: fixture.call.id }, { leaseUntil: new Date(Date.now() + 60000) })
    await expect(service().resolve({ actor, callId: fixture.call.id, input })).rejects.toThrow()
    expect(await ds.getRepository(HostingChargeResolutionEntity).count()).toBe(0)
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.reservation!.id })).toMatchObject({ state: 'uncertain' })
})
it('binds supplied usage/evidence to preview and refuses receipts outside original tariff window', async () => {
    const fixture = await uncertain(), draft = { ...fixture.draft, outcome: 'verified_usage' as const, supplierRequestId: 'receipt-test', supplierCreatedAt: fixture.call.sentAt!.toISOString(), usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, completion_tokens: 1000 } }, input = await command(fixture.call.id, draft)
    await expect(service().resolve({ actor, callId: fixture.call.id, input: { ...input, usage: { ...input.usage!, completion_tokens: 0 } } })).rejects.toThrow('CONFLICT')
    await expect(service().preview({ actor, callId: fixture.call.id, input: { ...draft, supplierCreatedAt: new Date(Date.now() - 3600000).toISOString() } })).rejects.toThrow('TARIFF_UNCERTAIN')
})

it('actual HTTP routes authorize the operator and bind preview/action, then replay exactly once', async () => {
    const fixture = await uncertain(), user = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: actor.identityId, platformId: actor.platformId })
    const token = await accessTokenManager(app.log).generateToken({ id: user.id, platform: { id: actor.platformId }, type: PrincipalType.USER, tokenVersion: actor.tokenVersion! }), headers = { authorization: `Bearer ${token}` }
    const listed = await app.inject({ url: `/charges/?platformId=${actor.platformId}`, headers })
    expect(listed.statusCode).toBe(200); expect(listed.json()).toMatchObject({ identity: { userId: user.id }, calls: [{ callId: fixture.call.id }] })
    const preview = await app.inject({ method: 'POST', url: `/charges/${fixture.call.id}/preview`, headers, payload: fixture.draft })
    expect(preview.statusCode).toBe(200)
    const value = preview.json().preview, payload = { ...fixture.draft, expectedRevision: value.expectedRevision, expectedState: value.expectedState, requestKey: apId() }
    const resolved = await app.inject({ method: 'POST', url: `/charges/${fixture.call.id}/resolve`, headers, payload })
    expect(resolved.statusCode).toBe(200); expect(resolved.json()).toMatchObject({ replayed: false, view: { state: 'cancelled' } })
    expect(resolved.headers['cache-control']).toBe('private, no-store')
    const replay = await app.inject({ method: 'POST', url: `/charges/${fixture.call.id}/resolve`, headers, payload })
    expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ replayed: true, auditId: resolved.json().auditId })
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    const denied = await app.inject({ url: `/charges/${fixture.call.id}?platformId=${actor.platformId}`, headers })
    expect(denied.statusCode).toBe(403); expect(denied.json()).toEqual({ code: 'HOSTING_OPERATOR_REQUIRED' })
})
it('keeps legacy microUSD grant settlement separate from unified conversion', async () => {
    const fixture = await uncertain(), legacy = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'managed_ai' })
    await ds.getRepository(HostingGrantEntity).update({ id: fixture.reservation!.grantId }, { reserved: 0n })
    await ds.getRepository(HostingGrantEntity).update({ id: legacy.id }, { reserved: 5000n })
    await ds.getRepository(HostingReservationEntity).update({ id: fixture.reservation!.id }, { accountingVersion: null, grantId: legacy.id, amount: 5000n, microUsdPerCredit: 500n, supplierMaxMicroUsd: null, legacyCreditGrantId: fixture.reservation!.grantId })
    const draft = { ...fixture.draft, outcome: 'verified_usage' as const, supplierCreatedAt: fixture.call.sentAt!.toISOString(), supplierRequestId: 'legacy-receipt', usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, completion_tokens: 1000 } }
    await service().resolve({ actor, callId: fixture.call.id, input: await command(fixture.call.id, draft) })
    expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: legacy.id })).toMatchObject({ consumed: 600n, reserved: 0n })
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.reservation!.id })).toMatchObject({ actualAmount: 600n, accountingVersion: null, actualSupplierMicroUsd: null })
})
it('settles genuine zero usage without refunding base Credit, and suspends bound violations', async () => {
    const fixture = await uncertain(), draft = { ...fixture.draft, outcome: 'verified_usage' as const, supplierCreatedAt: fixture.call.sentAt!.toISOString(), supplierRequestId: 'zero-receipt', usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens: 0 } }
    await service().resolve({ actor, callId: fixture.call.id, input: await command(fixture.call.id, draft) })
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.reservation!.id })).toMatchObject({ state: 'settled', actualAmount: 0n })
    expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: fixture.reservation!.grantId })).toMatchObject({ consumed: 1n })
    const other = await uncertain(), excessive = { ...draft, rootReservationId: other.root.id, supplierCreatedAt: other.call.sentAt!.toISOString(), usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100000, completion_tokens: 1000 } }
    await service().resolve({ actor, callId: other.call.id, input: await command(other.call.id, excessive) })
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ status: 'suspended', activeExecutions: 0 })
})
it.runIf(pgMode)('serializes competing operator commands and preserves the immutable winning audit', async () => {
    const fixture = await uncertain(), id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Second', lastName: 'Operator', tokenVersion: 'original' })
    const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-charge-resolution-secret-atleast32' }), id)
    const second = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }, a = await command(fixture.call.id, fixture.draft)
    const preview = await service().preview({ actor: second, callId: fixture.call.id, input: fixture.draft }), b = { ...fixture.draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() }
    const results = await Promise.allSettled([service().resolve({ actor, callId: fixture.call.id, input: a }), service().resolve({ actor: second, callId: fixture.call.id, input: b })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await ds.getRepository(HostingChargeResolutionEntity).countBy({ callId: fixture.call.id })).toBe(1)
    expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: fixture.reservation!.grantId })).toMatchObject({ reserved: 0n, consumed: 1n })
})

it.runIf(pgMode)('fences a real late gateway settlement racing an operator no-send resolution', async () => {
    await saveManagedSettings({ dataSource: ds, actor, input: { expectedRevision: 0, expectedGlobalRevision: 0, requestKey: apId(), mode: 'set', model: 'deepseek-flash', credentialAction: 'replace', apiKey: 'synthetic-resolution-provider-key-not-real' } })
    const html = readFileSync(new URL('../fixtures/hosting-official-pricing.html', import.meta.url), 'utf8'), pricing = createHostedPricing({ dataSource: ds, fetchSource: async () => ({ html, date: new Date().toUTCString(), age: '0' }) })
    await pricing.observe()
    const price = await tx.run({ dataSource: ds, fn: async manager => hostedPricingView(manager, await tx.now(manager)) })
    await pricing.approve({ actor, input: { expectedRevision: price.revision, observationId: price.observationId!, termsHash: price.termsHash!, requestKey: apId(), validUntil: PRICING_CALENDAR.until, calendarVersion: PRICING_CALENDAR.version } })
    const root = await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' }), rootClaim = await ledger().claimExecution({ actor, reservationId: root.id }), admissionId = apId(), segmentId = apId()
    await ds.getRepository(HostingDispatchEntity).insert({ id: segmentId, platformId: actor.platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 'a'.repeat(64), state: 'running', rootKey: apId(), reservationId: root.id, admissionId, dispatchId: rootClaim.dispatchId, leaseUntil: new Date(Date.now() + 60000), payload: scopedAiActionPayload({ platformId: actor.platformId, projectId }) })
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>(resolve => {
            entered = resolve
        }), providerPromise = new Promise<void>(resolve => {
            release = resolve
        })
    const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic', endpoint: 'diagnostic://no-network', complete: async () => {
        entered(); await providerPromise
        return { status: 200, data: { id: 'synthetic-supplier-receipt', model: 'deepseek-flash', created: Math.floor(Date.now() / 1000), object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic result' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 } } }
    } } })
    const sending = gateway.execute({ scope: { admissionId, platformId: actor.platformId, projectId }, request: { callKey: 'actual:race', attempt: 0, payer: { type: 'managed' }, model: 'sydekyks', messages: [{ role: 'user', content: 'Synthetic request' }], max_tokens: 1000 } }).then(value => ({ value }), error => ({ error }))
    await Promise.race([enteredPromise, sending.then(outcome => {
        if ('error' in outcome) throw outcome.error
    })])
    const call = await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ segmentId })
    await ds.getRepository(HostingModelCallEntity).update({ id: call.id }, { state: 'uncertain', leaseUntil: new Date(Date.now() - 1000) })
    await ledger().markUncertain({ platformId: actor.platformId, reservationId: call.reservationId!, dispatchId: call.dispatchId! })
    await ledger().markUncertain({ platformId: actor.platformId, reservationId: root.id, dispatchId: rootClaim.dispatchId! })
    await ds.getRepository(HostingDispatchEntity).update({ id: segmentId }, { state: 'uncertain', completionStatus: EngineResponseStatus.INTERNAL_ERROR, leaseUntil: new Date(Date.now() - 1000) })
    const draft: ChargeResolutionDraftInput = { platformId: actor.platformId, rootReservationId: root.id, outcome: 'confirmed_not_sent', reason: 'Synthetic contradictory race proof only', evidenceReference: 'Synthetic provider evidence fixture for lock-race test' }, input = await command(call.id, draft)
    const resolving = service().resolve({ actor, callId: call.id, input }).then(value => ({ value }), error => ({ error }))
    release()
    const [operator, supplier] = await Promise.all([resolving, sending]), after = await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ id: call.id }), held = await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: call.reservationId! }), budget = await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: call.budgetDay! })
    expect(budget.reserved).toBe(0n)
    if ('value' in operator) {
        expect(supplier).toHaveProperty('error'); expect(after.state).toBe('cancelled'); expect(held.state).toBe('released'); expect(budget.consumed).toBe(0n)
    }
    else {
        expect(supplier).toHaveProperty('value'); expect(after.state).toBe('settled'); expect(held.state).toBe('settled'); expect(budget.consumed).toBeGreaterThan(0n)
        expect(await ds.getRepository(HostingChargeResolutionEntity).count()).toBe(0)
    }
})

it('ignores late worker INTERNAL_ERROR receipts after explicit failed resolution without resurrecting capacity', async () => {
    const fixture = await uncertain(), queueName = 'synthetic-resolution', jobId = fixture.segmentId, queueToken = 'synthetic-lock', connectionId = apId()
    await ds.getRepository(HostingDispatchEntity).update({ id: fixture.segmentId }, { queueKey: createHash('sha256').update(JSON.stringify([queueName, jobId])).digest('hex'), queueTokenHash: createHash('sha256').update(queueToken).digest('hex'), connectionId })
    await service().resolve({ actor, callId: fixture.call.id, input: await command(fixture.call.id, fixture.draft) })
    await createHostedExecution({ dataSource: ds }).complete({ queueName, jobId, queueToken, connectionId, admissionId: fixture.call.admissionId, status: EngineResponseStatus.INTERNAL_ERROR })
    expect(await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ id: fixture.segmentId })).toMatchObject({ state: 'completed', resolutionStatus: 'FAILED' })
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.root.id })).toMatchObject({ state: 'settled' })
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 0 })
})

it('resolves multiple uncertain sibling holds sequentially and releases root capacity only once after the last', async () => {
    const fixture = await uncertain()
    await ds.getRepository(HostingReservationEntity).update({ id: fixture.root.id }, { state: 'running' })
    await ds.getRepository(HostingReservationEntity).update({ id: fixture.reservation!.id }, { state: 'running' })
    await ds.getRepository(HostingModelCallEntity).update({ id: fixture.call.id }, { state: 'running' })
    const reservation = await ledger().reserveManagedCall({ actor, rootReservationId: fixture.root.id, key: apId(), maxCostMicroUsd: 2500n }), claim = await ledger().claimManagedCall({ actor, reservationId: reservation.id })
    await ledger().markUncertain({ platformId: actor.platformId, reservationId: reservation.id, dispatchId: claim.dispatchId! })
    await ds.getRepository(HostingReservationEntity).update({ id: fixture.root.id }, { state: 'uncertain' })
    await ds.getRepository(HostingReservationEntity).update({ id: fixture.reservation!.id }, { state: 'uncertain' })
    await ds.getRepository(HostingModelCallEntity).update({ id: fixture.call.id }, { state: 'uncertain' })
    const sibling = await ds.getRepository(HostingModelCallEntity).save({ ...fixture.call, id: apId(), callKey: 'sibling:1', reservationId: reservation.id, dispatchId: claim.dispatchId, fence: apId() })
    const first = await service().resolve({ actor, callId: fixture.call.id, input: await command(fixture.call.id, fixture.draft) })
    expect(first.view.blockers).toContain('UNRESOLVED_SIBLING_CALL')
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 1 })
    expect(await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: fixture.call.budgetDay! })).toMatchObject({ reserved: 2500n, consumed: 0n })
    const input = await command(sibling.id, fixture.draft)
    await service().resolve({ actor, callId: sibling.id, input }); await service().resolve({ actor, callId: sibling.id, input })
    expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 0 })
    expect(await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: fixture.call.budgetDay! })).toMatchObject({ reserved: 0n, consumed: 0n })
})
