import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { apId } from '@activepieces/core-utils'
import { EngineResponseStatus } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { createHostedAiGateway } from '../../src/app/hosting/hosting-ai-gateway'
import { createHostedChargeResolution } from '../../src/app/hosting/hosting-charge-resolution'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingGrantEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { HostingRootCreditUsageEntity } from '../../src/app/hosting/hosting-inclusive-credits-entity'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { saveManagedSettings } from '../../src/app/hosting/hosting-managed-settings'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedNativeTools } from '../../src/app/hosting/hosting-native-tools'
import { NativeToolInput, NativeToolProvider } from '../../src/app/hosting/hosting-native-provider'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPricing, hostedPricingView } from '../../src/app/hosting/hosting-pricing'
import { PRICING_CALENDAR } from '../../src/app/hosting/hosting-pricing-source'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator, migratedHostedPGlite, scopedAiActionPayload } from '../helpers/hosting-fixtures'

let ds: DataSource, actor: HostingActor, projectId: string
const ledger = () => createHostedLedger({ dataSource: ds })
const table = '<table><tr><th>API</th><th>Unit</th><th>Price</th></tr><tr><td>Search</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr><tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr></table>'
const balance = () => ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'execution' })
const nativeRequest = (kind: 'search' | 'fetch' = 'search', payer: NativeToolInput['payer'] = { type: 'managed' }): NativeToolInput => ({ callKey: `native:${createHash('sha256').update(apId()).digest('hex')}`, attempt: 0, payer, model: payer.type === 'managed' ? 'sydekyks' : 'deepseek-flash', kind, ...(kind === 'search' ? { query: 'Synthetic research' } : { url: 'https://example.com/article' }) })

beforeAll(async () => { ds = await migratedHostedPGlite() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
beforeEach(async () => {
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Native', lastName: 'Fixture', tokenVersion: 'initial' })
    const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-native-tools-secret-atleast32chars' }), identityId)
    actor = { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }; projectId = home.projectId!
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', identityId)
})

async function configure(includeNative = true) {
    await saveManagedSettings({ dataSource: ds, actor, input: { expectedRevision: 0, expectedGlobalRevision: 0, requestKey: apId(), mode: 'set', model: 'deepseek-flash', credentialAction: 'replace', apiKey: 'synthetic-managed-native-key-not-real' } })
    const html = readFileSync(new URL('../fixtures/hosting-official-pricing.html', import.meta.url), 'utf8') + (includeNative ? table : '')
    const pricing = createHostedPricing({ dataSource: ds, fetchSource: async () => ({ html, date: new Date().toUTCString(), age: '0' }) })
    await pricing.observe()
    const view = await tx.run({ dataSource: ds, fn: async manager => hostedPricingView(manager, await tx.now(manager)) })
    await pricing.approve({ actor, input: { expectedRevision: view.revision, observationId: view.observationId!, termsHash: view.termsHash!, requestKey: apId(), validUntil: PRICING_CALENDAR.until, calendarVersion: PRICING_CALENDAR.version } })
}
async function root(payer: 'managed' | 'byok' = 'managed', configId?: string, enabled = true) {
    const reservation = await ledger().reserveExecution({ actor, projectId, key: apId(), payer })
    // Historical additive V3 roots remain additive when they later invoke native tools.
    await ds.getRepository(HostingRootCreditUsageEntity).delete({ id: reservation.id })
    await ds.getRepository(HostingReservationEntity).update({ id: reservation.id }, { accountingVersion: 'single-credits-1500-microusd-v3' })
    const claim = await ledger().claimExecution({ actor, reservationId: reservation.id }), admissionId = apId(), segmentId = apId()
    const payload = scopedAiActionPayload({ platformId: actor.platformId, projectId, payer, configId })
    if ('settings' in payload.step) payload.step.settings.input.webSearch = enabled
    await ds.getRepository(HostingDispatchEntity).insert({ id: segmentId, platformId: actor.platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 'a'.repeat(64), state: 'running', rootKey: apId(), reservationId: reservation.id, admissionId, dispatchId: claim.dispatchId, leaseUntil: new Date(Date.now() + 60000), payload })
    return { reservation, dispatchId: claim.dispatchId!, segmentId, scope: { admissionId, platformId: actor.platformId, projectId } }
}
async function byok() {
    const id = apId()
    await ds.getRepository(AIProviderEntity).insert({ id, platformId: actor.platformId, provider: 'deepseek', displayName: 'Synthetic native BYOK', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-native-byok-key-not-real' }), config: {}, status: 'active', enabledForChat: false, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
    return id
}
const successful = vi.fn(async (_input: Parameters<NativeToolProvider['execute']>[0]) => ({ status: 200, data: { results: [{ title: 'Source', url: 'https://example.com/source', snippet: 'Reference' }] } }))
const modelRequest = { callKey: 'model:0', attempt: 0, payer: { type: 'managed' as const }, model: 'sydekyks' as const, messages: [{ role: 'user' as const, content: 'Synthetic question' }], max_tokens: 100 }
const modelProvider = () => ({ id: 'synthetic', endpoint: 'https://api.deepseek.com/chat/completions', complete: vi.fn(async () => ({ status: 200, data: { id: 'synthetic', model: 'deepseek-flash', created: Math.floor(Date.now() / 1000), object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer' } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } } })) })

describe('historical V3 native tools use the additive Credits ledger', () => {
    it('charges one Credit per successful750microUSD search plus model usage and one execution; replay never resends or charges twice', async () => {
        await configure(); const admitted = await root(), execute = vi.fn(successful), tools = createHostedNativeTools({ dataSource: ds, provider: { execute } }), request = nativeRequest()
        const first = await tools.execute({ scope: admitted.scope, request }), replay = await tools.execute({ scope: admitted.scope, request })
        expect(replay).toEqual(first); expect(execute).toHaveBeenCalledTimes(1)
        expect(execute.mock.calls[0][0].apiKey).toBe('synthetic-managed-native-key-not-real')
        expect(await balance()).toMatchObject({ consumed: 2n, reserved: 0n })
        await createHostedAiGateway({ dataSource: ds, provider: modelProvider() }).execute({ scope: admitted.scope, request: modelRequest })
        expect(await balance()).toMatchObject({ consumed: 3n, reserved: 0n })
        expect(await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ callKey: request.callKey })).toMatchObject({ nativeTool: 'search', nativeFeature: true, toolUnitPriceMicroUsd: '750', actualMicroUsd: '750', state: 'settled', usage: { successful_requests: 1 } })
        await ledger().finishExecution({ platformId: actor.platformId, reservationId: admitted.reservation.id, dispatchId: admitted.dispatchId })
    })
    it.each([{ status: 200, data: { results: [] } }, { status: 429, data: { error: 'synthetic' } }])('releases known nonbillable result $status without consuming AI Credits', async response => {
        await configure(); const admitted = await root(), tools = createHostedNativeTools({ dataSource: ds, provider: { execute: async () => response } })
        await tools.execute({ scope: admitted.scope, request: nativeRequest() })
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
    })
    it('retains unknown charges, blocks both retry and model calls, then resolves the same hold with an audited receipt', async () => {
        await configure(); const admitted = await root(), execute = vi.fn(async () => { throw new Error('Synthetic network timeout') }), tools = createHostedNativeTools({ dataSource: ds, provider: { execute } }), request = nativeRequest()
        await expect(tools.execute({ scope: admitted.scope, request })).rejects.toThrow('OUTCOME_UNCERTAIN')
        await expect(tools.execute({ scope: admitted.scope, request })).rejects.toThrow('OUTCOME_UNAVAILABLE')
        await expect(createHostedAiGateway({ dataSource: ds, provider: modelProvider() }).execute({ scope: admitted.scope, request: modelRequest })).rejects.toThrow('OUTCOME_UNCERTAIN')
        await expect(ledger().finishExecution({ platformId: actor.platformId, reservationId: admitted.reservation.id, dispatchId: admitted.dispatchId })).rejects.toThrow('UNSETTLED_CHILDREN')
        expect(execute).toHaveBeenCalledTimes(1); expect(await balance()).toMatchObject({ consumed: 1n, reserved: 1n })
        const call = await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ callKey: request.callKey }), expired = new Date(Date.now() - 1000)
        await ds.getRepository(HostingModelCallEntity).update({ id: call.id }, { leaseUntil: expired })
        await ds.getRepository(HostingDispatchEntity).update({ id: admitted.segmentId }, { state: 'uncertain', leaseUntil: expired, completionStatus: EngineResponseStatus.INTERNAL_ERROR })
        const service = createHostedChargeResolution({ dataSource: ds }), draft = { platformId: actor.platformId, rootReservationId: admitted.reservation.id, outcome: 'verified_usage' as const, billable: true, supplierRequestId: 'synthetic-search-receipt', supplierCreatedAt: call.sentAt!.toISOString(), reason: 'Synthetic supplier investigation', evidenceReference: 'Synthetic authoritative successful search receipt' }
        const preview = await service.preview({ actor, callId: call.id, input: draft })
        expect(preview.preview.actualCredits).toBe('1')
        await service.resolve({ actor, callId: call.id, input: { ...draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() } })
        expect(await balance()).toMatchObject({ consumed: 2n, reserved: 0n })
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: admitted.reservation.id })).toMatchObject({ state: 'settled' })
    })
    it('uses the exact BYOK key, creates no managed hold, and keeps unknown BYOK calls blocking completion', async () => {
        await configure(); const configId = await byok(), admitted = await root('byok', configId), execute = vi.fn(successful), request = nativeRequest('search', { type: 'byok', configId }), tools = createHostedNativeTools({ dataSource: ds, provider: { execute } })
        await tools.execute({ scope: admitted.scope, request })
        expect(execute.mock.calls[0][0].apiKey).toBe('synthetic-native-byok-key-not-real')
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await ds.getRepository(HostingReservationEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(0)
        await ds.getRepository(AIProviderEntity).update({ id: configId }, { status: 'rejected' })
        await expect(tools.execute({ scope: admitted.scope, request: nativeRequest('search', { type: 'byok', configId }) })).rejects.toThrow('BYOK_SCOPE_DENIED')
        expect(execute).toHaveBeenCalledTimes(1)
    })
    it('keeps an unknown BYOK tool in the same admin recovery journey, including a mixed managed root', async () => {
        await configure(); const configId = await byok(), admitted = await root('byok', configId)
        // Mixed workflows reserve a managed root but retain the exact selected
        // BYOK payer on each supplier call. No managed fallback is authorized.
        await ds.getRepository(HostingReservationEntity).update({ id: admitted.reservation.id }, { payer: 'managed' })
        const execute = vi.fn(async () => { throw new Error('Synthetic unknown BYOK outcome') }), tools = createHostedNativeTools({ dataSource: ds, provider: { execute } }), request = nativeRequest('search', { type: 'byok', configId })
        await expect(tools.execute({ scope: admitted.scope, request })).rejects.toThrow('OUTCOME_UNCERTAIN')
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
        await expect(ledger().finishExecution({ platformId: actor.platformId, reservationId: admitted.reservation.id, dispatchId: admitted.dispatchId })).rejects.toThrow('UNSETTLED_CHILDREN')
        const call = await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ callKey: request.callKey }), expired = new Date(Date.now() - 1000)
        await ds.getRepository(HostingModelCallEntity).update({ id: call.id }, { leaseUntil: expired })
        await ds.getRepository(HostingDispatchEntity).update({ id: admitted.segmentId }, { state: 'uncertain', leaseUntil: expired, completionStatus: EngineResponseStatus.INTERNAL_ERROR })
        const service = createHostedChargeResolution({ dataSource: ds }), draft = { platformId: actor.platformId, rootReservationId: admitted.reservation.id, outcome: 'verified_usage' as const, billable: false, supplierRequestId: 'synthetic-empty-byok-search', supplierCreatedAt: call.sentAt!.toISOString(), reason: 'Synthetic BYOK investigation', evidenceReference: 'Synthetic supplier receipt confirms empty results' }
        const preview = await service.preview({ actor, callId: call.id, input: draft })
        expect(preview.preview.actualCredits).toBe('0')
        await service.resolve({ actor, callId: call.id, input: { ...draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() } })
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: admitted.reservation.id })).toMatchObject({ state: 'settled' })
        expect(execute).toHaveBeenCalledTimes(1)
    })
    it('enforces persisted opt-in, approved native rates, two-search cap and total100Credit exposure before supplier dispatch', async () => {
        await configure(); const disabled = await root('managed', undefined, false), execute = vi.fn(successful), tools = createHostedNativeTools({ dataSource: ds, provider: { execute } })
        await expect(tools.execute({ scope: disabled.scope, request: nativeRequest() })).rejects.toThrow('FEATURE_DENIED')
        await ledger().finishExecution({ platformId: actor.platformId, reservationId: disabled.reservation.id, dispatchId: disabled.dispatchId })
        const admitted = await root()
        await tools.execute({ scope: admitted.scope, request: nativeRequest() }); await tools.execute({ scope: admitted.scope, request: nativeRequest() })
        await expect(tools.execute({ scope: admitted.scope, request: nativeRequest() })).rejects.toThrow('TOOL_LIMIT')
        expect(execute).toHaveBeenCalledTimes(2)
        // Seed ordinary model exposure on the same root: the native cap counts it
        // together with execution, settled tools and the proposed next tool.
        const held = await ledger().reserveManagedCall({ actor, rootReservationId: admitted.reservation.id, key: apId(), maxCostMicroUsd: 145_500n })
        expect(held.amount).toBe(97n)
        const fetcher = createHostedNativeTools({ dataSource: ds, provider: { execute }, validateUrl: async value => value })
        await expect(fetcher.execute({ scope: admitted.scope, request: nativeRequest('fetch') })).rejects.toThrow('NATIVE_CREDIT_LIMIT')
        expect(execute).toHaveBeenCalledTimes(2)
    })
    it('keeps token-only approval compatible with ordinary calls while refusing unapproved native fees', async () => {
        await configure(false); const admitted = await root(), execute = vi.fn(successful)
        await expect(createHostedNativeTools({ dataSource: ds, provider: { execute } }).execute({ scope: admitted.scope, request: nativeRequest() })).rejects.toThrow('NATIVE_PRICING_APPROVAL_REQUIRED')
        await createHostedAiGateway({ dataSource: ds, provider: modelProvider() }).execute({ scope: admitted.scope, request: modelRequest })
        expect(execute).not.toHaveBeenCalled()
    })
})

describe('historical V3 independent native Credits boundary acceptance', () => {
    it('refuses zero available Credits before any supplier call or native reservation', async () => {
        await configure()
        const admitted = await root(), grant = await balance(), execute = vi.fn(successful)
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: grant.consumed + grant.reserved })
        const tools = createHostedNativeTools({ dataSource: ds, provider: { execute } })
        await expect(tools.execute({ scope: admitted.scope, request: nativeRequest() })).rejects.toThrow('HOSTING_CREDITS_EXHAUSTED')
        expect(execute).not.toHaveBeenCalled()
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(0)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(0)
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
    })

    it.each([{ priorCredits: 98n, allowed: true }, { priorCredits: 99n, allowed: false }])('admits exactly100 total Credits and refuses101 (prior=$priorCredits)', async ({ priorCredits, allowed }) => {
        await configure()
        const admitted = await root(), execute = vi.fn(successful), request = nativeRequest()
        const held = await ledger().reserveManagedCall({ actor, rootReservationId: admitted.reservation.id, key: apId(), maxCostMicroUsd: priorCredits * 1500n })
        expect(held.amount).toBe(priorCredits)
        const tools = createHostedNativeTools({ dataSource: ds, provider: { execute } })
        if (allowed) {
            await tools.execute({ scope: admitted.scope, request })
            expect(execute).toHaveBeenCalledTimes(1)
            expect(await balance()).toMatchObject({ consumed: 2n, reserved: 98n })
            expect(await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ callKey: request.callKey })).toMatchObject({ inputTokenBound: null, nativeTool: 'search', state: 'settled', actualMicroUsd: '750' })
        }
        else {
            await expect(tools.execute({ scope: admitted.scope, request })).rejects.toThrow('HOSTING_NATIVE_CREDIT_LIMIT')
            expect(execute).not.toHaveBeenCalled()
            expect(await balance()).toMatchObject({ consumed: 1n, reserved: 99n })
            expect(await ds.getRepository(HostingModelCallEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(0)
        }
    })

    it.each([{ held: 68n, allowed: true }, { held: 69n, allowed: false }])('counts v1 settled and v2 pending Credits at the same native100Credit cap (held=$held)', async ({ held, allowed }) => {
        await configure()
        const admitted = await root(), grant = await balance(), execute = vi.fn(successful)
        const common = { platformId: actor.platformId, projectId, identityId: actor.identityId, grantId: grant.id, kind: 'managed_ai' as const, payer: 'managed' as const, rootReservationId: admitted.reservation.id, day: new Date().toISOString().slice(0, 10), dispatchId: apId() }
        const oldIds = [apId(), apId()]
        await ds.getRepository(HostingReservationEntity).insert([
            { ...common, id: oldIds[0], key: 'native:old-v1-settled', state: 'settled', accountingVersion: 'single-credits-500-microusd-v1', microUsdPerCredit: 500n, amount: 30n, actualAmount: 30n, supplierMaxMicroUsd: 15000n, actualSupplierMicroUsd: 15000n },
            { ...common, id: oldIds[1], key: 'native:old-v2-held', state: 'running', accountingVersion: 'single-credits-250-microusd-v2', microUsdPerCredit: 250n, amount: held, actualAmount: null, supplierMaxMicroUsd: held * 250n },
        ])
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { consumed: 31n, reserved: held })
        const oldRows = await ds.getRepository(HostingReservationEntity).findBy([{ id: oldIds[0] }, { id: oldIds[1] }])
        const tools = createHostedNativeTools({ dataSource: ds, provider: { execute } })
        if (allowed) {
            await tools.execute({ scope: admitted.scope, request: nativeRequest() })
            expect(await balance()).toMatchObject({ consumed: 32n, reserved: held })
            expect(execute).toHaveBeenCalledTimes(1)
        }
        else {
            await expect(tools.execute({ scope: admitted.scope, request: nativeRequest() })).rejects.toThrow('HOSTING_NATIVE_CREDIT_LIMIT')
            expect(execute).not.toHaveBeenCalled()
            expect(await balance()).toMatchObject({ consumed: 31n, reserved: held })
        }
        expect(await ds.getRepository(HostingReservationEntity).findBy([{ id: oldIds[0] }, { id: oldIds[1] }])).toEqual(oldRows)
    })
    it('allows three page reads and rejects the fourth before dispatch or charging', async () => {
        await configure()
        const admitted = await root(), execute = vi.fn(async () => ({ status: 200, data: { title: 'Synthetic page', content: 'Synthetic public reference.' } }))
        const tools = createHostedNativeTools({ dataSource: ds, provider: { execute }, validateUrl: async value => value })
        for (let index = 0; index < 3; index++) await tools.execute({ scope: admitted.scope, request: nativeRequest('fetch') })
        await expect(tools.execute({ scope: admitted.scope, request: nativeRequest('fetch') })).rejects.toThrow('HOSTING_NATIVE_TOOL_LIMIT')
        expect(execute).toHaveBeenCalledTimes(3)
        expect(await balance()).toMatchObject({ consumed: 4n, reserved: 0n })
        const calls = await ds.getRepository(HostingModelCallEntity).findBy({ rootReservationId: admitted.reservation.id })
        expect(calls).toHaveLength(3)
        expect(calls.every(call => call.inputTokenBound === null && call.nativeTool === 'fetch' && call.state === 'settled' && call.actualMicroUsd === '750')).toBe(true)
    })
})
