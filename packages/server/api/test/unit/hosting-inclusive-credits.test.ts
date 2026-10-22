import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { apId } from '@activepieces/core-utils'
import { EngineResponseStatus } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { SydekyksInclusiveCredits1914000000000 } from '../../src/app/database/migration/postgres/1914000000000-SydekyksInclusiveCredits'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { HostedProviderRequest } from '../../src/app/hosting/hosting-ai-provider'
import { createHostedAiGateway } from '../../src/app/hosting/hosting-ai-gateway'
import { ChargeResolutionDraftInput, createHostedChargeResolution } from '../../src/app/hosting/hosting-charge-resolution'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingDailyBudgetEntity, HostingGrantEntity, HostingLedgerEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
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

const V4 = 'single-credits-inclusive-1500-microusd-v4'
const V3 = 'single-credits-1500-microusd-v3'
let ds: DataSource, actor: HostingActor, projectId: string
const ledger = () => createHostedLedger({ dataSource: ds })
const grant = () => ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'execution' })
const day = () => new Date().toISOString().slice(0, 10)
const budget = () => ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: day() })
const nativeTable = '<table><tr><th>API</th><th>Unit</th><th>Price</th></tr><tr><td>Search</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr><tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr></table>'

beforeAll(async () => { ds = await migratedHostedPGlite() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
beforeEach(async () => {
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Inclusive', lastName: 'Fixture', tokenVersion: 'initial' })
    const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-inclusive-secret-atleast32characters' }), identityId)
    actor = { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }; projectId = home.projectId!
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', identityId)
})

async function root(payer: 'managed' | 'byok' = 'managed', configId?: string) {
    const reservation = await ledger().reserveExecution({ actor, projectId, key: apId(), payer })
    expect(reservation).toMatchObject({ accountingVersion: V4, microUsdPerCredit: 1500n })
    expect(await ds.getRepository(HostingRootCreditUsageEntity).findOneByOrFail({ id: reservation.id })).toMatchObject({ microUsdPerCredit: 1500n, consumedCredits: 0n, reservedCredits: 1n })
    const claim = await ledger().claimExecution({ actor, reservationId: reservation.id }), admissionId = apId(), segmentId = apId()
    expect(await ds.getRepository(HostingRootCreditUsageEntity).findOneByOrFail({ id: reservation.id })).toMatchObject({ consumedCredits: 1n, reservedCredits: 0n })
    const payload = scopedAiActionPayload({ platformId: actor.platformId, projectId, payer, configId })
    if ('settings' in payload.step) payload.step.settings.input.webSearch = true
    await ds.getRepository(HostingDispatchEntity).insert({ id: segmentId, platformId: actor.platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 'a'.repeat(64), state: 'running', rootKey: apId(), reservationId: reservation.id, admissionId, dispatchId: claim.dispatchId, leaseUntil: new Date(Date.now() + 60000), payload })
    return { reservation, dispatchId: claim.dispatchId!, segmentId, scope: { admissionId, platformId: actor.platformId, projectId } }
}
const reserve = (rootId: string, bound: bigint, key = apId()) => ledger().reserveManagedCall({ actor, rootReservationId: rootId, key, maxCostMicroUsd: bound })
async function settle(rootId: string, actual: bigint, bound = actual > 0n ? actual : 1n) {
    const call = await reserve(rootId, bound), claim = await ledger().claimManagedCall({ actor, reservationId: call.id })
    expect(call).toMatchObject({ accountingVersion: V4, amount: 0n, actualAmount: 0n, microUsdPerCredit: 1500n, supplierMaxMicroUsd: bound })
    await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: call.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: actual })
    expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: call.id })).toMatchObject({ actualAmount: 0n, actualSupplierMicroUsd: actual })
    return { call, dispatchId: claim.dispatchId! }
}
async function configure() {
    await saveManagedSettings({ dataSource: ds, actor, input: { expectedRevision: 0, expectedGlobalRevision: 0, requestKey: apId(), mode: 'set', model: 'deepseek-flash', credentialAction: 'replace', apiKey: 'synthetic-inclusive-managed-key-not-real' } })
    const html = readFileSync(new URL('../fixtures/hosting-official-pricing.html', import.meta.url), 'utf8') + nativeTable
    const pricing = createHostedPricing({ dataSource: ds, fetchSource: async () => ({ html, date: new Date().toUTCString(), age: '0' }) })
    await pricing.observe()
    const current = await tx.run({ dataSource: ds, fn: async manager => hostedPricingView(manager, await tx.now(manager)) })
    await pricing.approve({ actor, input: { expectedRevision: current.revision, observationId: current.observationId!, termsHash: current.termsHash!, requestKey: apId(), validUntil: PRICING_CALENDAR.until, calendarVersion: PRICING_CALENDAR.version } })
}
const nativeRequest = (kind: 'search' | 'fetch' = 'search', payer: NativeToolInput['payer'] = { type: 'managed' }): NativeToolInput => ({ callKey: `native:${createHash('sha256').update(apId()).digest('hex')}`, attempt: 0, payer, model: payer.type === 'managed' ? 'sydekyks' : 'deepseek-flash', kind, ...(kind === 'search' ? { query: 'Synthetic research' } : { url: 'https://example.com/article' }) })
const successful: NativeToolProvider['execute'] = async ({ request }) => ({ status: 200, data: request.kind === 'fetch' ? { title: 'Synthetic page', content: 'Synthetic public reference.' } : { results: [{ title: 'Source', url: 'https://example.com/source', snippet: 'Reference' }] } })
const modelRequest = { callKey: 'inclusive:model', attempt: 0, payer: { type: 'managed' as const }, model: 'sydekyks' as const, messages: [{ role: 'user' as const, content: 'Synthetic question' }], max_tokens: 100 }
const modelProvider = () => ({ id: 'synthetic', endpoint: 'https://api.deepseek.com/chat/completions', complete: vi.fn(async (_input: HostedProviderRequest) => ({ status: 200, data: { id: 'synthetic', model: 'deepseek-flash', created: Math.floor(Date.now() / 1000), object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer' } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } } })) })

describe('inclusive Credits on newly admitted V4 roots', () => {
    it('releases the unsent base reservation exactly once and frees execution capacity', async () => {
        const reservation = await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })
        expect(await grant()).toMatchObject({ consumed: 0n, reserved: 1n })
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 1 })
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: reservation.id })
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: reservation.id })
        expect(await grant()).toMatchObject({ consumed: 0n, reserved: 0n })
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 0 })
        expect(await ds.getRepository(HostingRootCreditUsageEntity).findOneByOrFail({ id: reservation.id })).toMatchObject({ consumedCredits: 0n, reservedCredits: 0n })
        const next = await root()
        expect(next.reservation.id).not.toBe(reservation.id)
    })
    it('fails closed when a running root meter is missing without charging again or committing a supplier hold', async () => {
        const admitted = await root(), before = await grant(), entries = await ds.getRepository(HostingLedgerEntity).count()
        await ds.getRepository(HostingRootCreditUsageEntity).delete({ id: admitted.reservation.id })
        await expect(reserve(admitted.reservation.id, 750n)).rejects.toThrow('INCLUSIVE_ACCOUNTING_INVALID')
        await expect(ledger().finishExecution({ platformId: actor.platformId, reservationId: admitted.reservation.id, dispatchId: admitted.dispatchId })).rejects.toThrow('INCLUSIVE_ACCOUNTING_INVALID')
        expect(await grant()).toEqual(before)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(entries)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(0)
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: admitted.reservation.id })).toMatchObject({ state: 'running' })
        expect(await ds.getRepository(HostingDailyBudgetEntity).count()).toBe(0)
    })
    it('rejects a consumed-counter decrease instead of refunding Credits from inconsistent meter state', async () => {
        const admitted = await root(), before = await grant(), entries = await ds.getRepository(HostingLedgerEntity).count()
        await ds.getRepository(HostingRootCreditUsageEntity).update({ id: admitted.reservation.id }, { consumedCredits: 2n })
        await expect(reserve(admitted.reservation.id, 750n)).rejects.toThrow('INCLUSIVE_ACCOUNTING_INVALID')
        expect(await grant()).toEqual(before)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(entries)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(0)
    })
    it.each([['first', 'second'], ['second', 'first']])('settles two held calls in %s/%s order without per-call rounding', async (earlier, later) => {
        const admitted = await root(), first = await reserve(admitted.reservation.id, 1501n), second = await reserve(admitted.reservation.id, 1500n)
        const firstClaim = await ledger().claimManagedCall({ actor, reservationId: first.id }), secondClaim = await ledger().claimManagedCall({ actor, reservationId: second.id })
        const calls = { first: { reservation: first, dispatchId: firstClaim.dispatchId! }, second: { reservation: second, dispatchId: secondClaim.dispatchId! } }
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 2n })
        for (const [index, key] of [earlier, later].entries()) {
            const call = calls[key as keyof typeof calls]
            await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: call.reservation.id, dispatchId: call.dispatchId, actualCostMicroUsd: 750n })
            expect(await grant()).toMatchObject({ consumed: 1n, reserved: index === 0 ? 1n : 0n })
        }
        expect(await budget()).toMatchObject({ consumed: 1500n, reserved: 0n })
    })
    it('settles the later held call before cancelling the earlier unsent one', async () => {
        const admitted = await root(), first = await reserve(admitted.reservation.id, 1501n), second = await reserve(admitted.reservation.id, 1500n)
        const claim = await ledger().claimManagedCall({ actor, reservationId: second.id })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: second.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 750n })
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 1n })
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: first.id })
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 750n, reserved: 0n })
    })
    it('transfers a revoked grant hold into consumed without recording a revoke refund', async () => {
        const admitted = await root(), held = await reserve(admitted.reservation.id, 1501n), claim = await ledger().claimManagedCall({ actor, reservationId: held.id })
        const original = await grant()
        expect(original).toMatchObject({ consumed: 1n, reserved: 1n })
        await ds.getRepository(HostingGrantEntity).update({ id: original.id }, { revokedAt: new Date() })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: held.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 1501n })
        expect(await grant()).toMatchObject({ consumed: 2n, reserved: 0n })
        expect(await ds.getRepository(HostingLedgerEntity).countBy({ platformId: actor.platformId, operation: 'revoke' })).toBe(0)
        expect(await budget()).toMatchObject({ consumed: 1501n, reserved: 0n })
    })
    it.each([{ cost: 0n, credits: 1n }, { cost: 1n, credits: 1n }, { cost: 1499n, credits: 1n }, { cost: 1500n, credits: 1n }, { cost: 1501n, credits: 2n }, { cost: 3000n, credits: 2n }])('charges $credits total Credits for $cost microUSD, retaining base and replaying exactly once', async ({ cost, credits }) => {
        const admitted = await root(), result = await settle(admitted.reservation.id, cost)
        const before = await ds.getRepository(HostingLedgerEntity).count()
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: result.call.id, dispatchId: result.dispatchId, actualCostMicroUsd: cost })
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(before)
        await ledger().finishExecution({ platformId: actor.platformId, reservationId: admitted.reservation.id, dispatchId: admitted.dispatchId })
        expect(await grant()).toMatchObject({ consumed: credits, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: cost, reserved: 0n })
    })
    it.each([[750n, 750n], [750n, 751n], [751n, 750n], [1n, 1499n], [1499n, 1n]])('aggregates separate supplier calls in order %s then %s', async (first, second) => {
        const admitted = await root()
        await settle(admitted.reservation.id, first); await settle(admitted.reservation.id, second)
        expect(await grant()).toMatchObject({ consumed: first + second > 1500n ? 2n : 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: first + second, reserved: 0n })
    })
    it('holds the aggregate pending envelope and releases only the known unsent marginal amount', async () => {
        const admitted = await root()
        await settle(admitted.reservation.id, 750n)
        const first = await reserve(admitted.reservation.id, 750n), second = await reserve(admitted.reservation.id, 751n)
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 1n })
        expect(await budget()).toMatchObject({ consumed: 750n, reserved: 1501n })
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: second.id })
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: second.id })
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 750n, reserved: 750n })
        const claim = await ledger().claimManagedCall({ actor, reservationId: first.id })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: first.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 750n })
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
    })
    it('admits zero marginal exposure with zero free Credits and rejects an additional Credit before reservation', async () => {
        const initial = await grant(); await ds.getRepository(HostingGrantEntity).update({ id: initial.id }, { amount: 1n })
        const admitted = await root(), first = await reserve(admitted.reservation.id, 750n)
        const second = await reserve(admitted.reservation.id, 750n)
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        await expect(reserve(admitted.reservation.id, 1n)).rejects.toThrow('CREDITS_EXHAUSTED')
        expect(await ds.getRepository(HostingReservationEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(2)
        expect((await budget()).reserved).toBe(1500n)
        expect(first.amount + second.amount).toBe(0n)
    })
    it('settles uncertain original-grant liability after expiry and revocation without moving it to a replacement grant', async () => {
        const admitted = await root(), held = await reserve(admitted.reservation.id, 4500n), claim = await ledger().claimManagedCall({ actor, reservationId: held.id })
        await ledger().markUncertain({ platformId: actor.platformId, reservationId: held.id, dispatchId: claim.dispatchId! })
        const original = await grant()
        await ds.getRepository(HostingGrantEntity).update({ id: original.id }, { validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() - 1000), revokedAt: new Date() })
        const replacement = await ds.getRepository(HostingGrantEntity).save({ ...original, id: apId(), sourceKey: 'inclusive-replacement', consumed: 0n, reserved: 0n, validFrom: new Date(), validUntil: new Date(Date.now() + 60000), revokedAt: null })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: held.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 1501n })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: original.id })).toMatchObject({ consumed: 2n, reserved: 0n })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: replacement.id })).toMatchObject({ consumed: 0n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 1501n, reserved: 0n })
    })
    it('enforces the inclusive 1000 Credit root limit at the supplier boundary', async () => {
        const initial = await grant(); await ds.getRepository(HostingGrantEntity).update({ id: initial.id }, { amount: 10000n })
        const admitted = await root()
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: day(), limit: 10_000_000n, consumed: 0n, reserved: 0n })
        const held = await reserve(admitted.reservation.id, 1_500_000n)
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 999n })
        await expect(reserve(admitted.reservation.id, 1n)).rejects.toThrow('RUN_CREDIT_LIMIT')
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: held.id })
        await settle(admitted.reservation.id, 1_500_000n)
        expect(await grant()).toMatchObject({ consumed: 1000n, reserved: 0n })
        await expect(reserve(admitted.reservation.id, 1n)).rejects.toThrow('RUN_CREDIT_LIMIT')
    })
})

describe('real V4 model and native supplier journeys', () => {
    it('aggregates model, search and fetch supplier costs once across their real gateways', async () => {
        await configure(); const admitted = await root(), provider = modelProvider(), execute = vi.fn(successful)
        await createHostedAiGateway({ dataSource: ds, provider }).execute({ scope: admitted.scope, request: modelRequest })
        const tools = createHostedNativeTools({ dataSource: ds, provider: { execute }, validateUrl: async value => value })
        const search = nativeRequest(), fetch = nativeRequest('fetch')
        await tools.execute({ scope: admitted.scope, request: search }); await tools.execute({ scope: admitted.scope, request: fetch })
        await tools.execute({ scope: admitted.scope, request: search })
        expect(execute).toHaveBeenCalledTimes(2); expect(provider.complete).toHaveBeenCalledTimes(1)
        const calls = await ds.getRepository(HostingModelCallEntity).findBy({ rootReservationId: admitted.reservation.id })
        const actual = calls.reduce((total, call) => total + BigInt(call.actualMicroUsd!), 0n)
        expect(actual).toBeGreaterThan(1500n)
        expect(await grant()).toMatchObject({ consumed: (actual + 1499n) / 1500n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: actual, reserved: 0n })
        for (const child of await ds.getRepository(HostingReservationEntity).findBy({ rootReservationId: admitted.reservation.id })) expect(child).toMatchObject({ amount: 0n, actualAmount: 0n, accountingVersion: V4 })
    })
    it('admits two750microUSD searches on the sole base Credit and enforces supplier dollars on zero marginal calls', async () => {
        await configure(); const initial = await grant(); await ds.getRepository(HostingGrantEntity).update({ id: initial.id }, { amount: 1n })
        const admitted = await root(), execute = vi.fn(successful), tools = createHostedNativeTools({ dataSource: ds, provider: { execute } })
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: day(), limit: 1499n, consumed: 0n, reserved: 0n })
        await tools.execute({ scope: admitted.scope, request: nativeRequest() })
        await expect(tools.execute({ scope: admitted.scope, request: nativeRequest() })).rejects.toThrow('OPERATOR_BUDGET_EXHAUSTED')
        expect(execute).toHaveBeenCalledTimes(1)
        await ds.getRepository(HostingDailyBudgetEntity).update({ id: day() }, { limit: 1500n })
        await tools.execute({ scope: admitted.scope, request: nativeRequest() })
        expect(execute).toHaveBeenCalledTimes(2); expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 1500n, reserved: 0n })
    })
    it('rejects a native request over available aggregate Credits before sending it', async () => {
        await configure(); const initial = await grant(); await ds.getRepository(HostingGrantEntity).update({ id: initial.id }, { amount: 1n })
        const admitted = await root(); await settle(admitted.reservation.id, 751n)
        const execute = vi.fn(successful)
        await expect(createHostedNativeTools({ dataSource: ds, provider: { execute } }).execute({ scope: admitted.scope, request: nativeRequest() })).rejects.toThrow('CREDITS_EXHAUSTED')
        expect(execute).not.toHaveBeenCalled(); expect((await budget()).consumed).toBe(751n)
    })
    it.each([{ prior: 149_250n, allowed: true }, { prior: 149_251n, allowed: false }])('uses inclusive100 Credit native exposure with $prior pending supplier microUSD', async ({ prior, allowed }) => {
        await configure(); const admitted = await root(), execute = vi.fn(successful)
        await reserve(admitted.reservation.id, prior)
        const sending = createHostedNativeTools({ dataSource: ds, provider: { execute } }).execute({ scope: admitted.scope, request: nativeRequest() })
        if (allowed) { await sending; expect(execute).toHaveBeenCalledTimes(1); expect(await grant()).toMatchObject({ consumed: 1n, reserved: 99n }) }
        else { await expect(sending).rejects.toThrow('NATIVE_CREDIT_LIMIT'); expect(execute).not.toHaveBeenCalled() }
    })
    it('retains unknown supplier exposure, blocks retries and never resends the provider request', async () => {
        await configure(); const admitted = await root(), request = nativeRequest(), execute = vi.fn(async () => { throw new Error('Synthetic unknown transport outcome') })
        const tools = createHostedNativeTools({ dataSource: ds, provider: { execute } })
        await expect(tools.execute({ scope: admitted.scope, request })).rejects.toThrow('OUTCOME_UNCERTAIN')
        await expect(tools.execute({ scope: admitted.scope, request })).rejects.toThrow('OUTCOME_UNAVAILABLE')
        await expect(tools.execute({ scope: admitted.scope, request: nativeRequest() })).rejects.toThrow('OUTCOME_UNCERTAIN')
        expect(execute).toHaveBeenCalledTimes(1)
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 0n, reserved: 750n })
        await expect(ledger().finishExecution({ platformId: actor.platformId, reservationId: admitted.reservation.id, dispatchId: admitted.dispatchId })).rejects.toThrow('UNSETTLED_CHILDREN')
    })
    it('releases an aborted model request known unsent, then admits the explicit retry without refunding base', async () => {
        await configure(); const admitted = await root(), provider = modelProvider(), gateway = createHostedAiGateway({ dataSource: ds, provider })
        const controller = new AbortController(); controller.abort()
        await expect(gateway.execute({ scope: admitted.scope, request: modelRequest, signal: controller.signal })).rejects.toThrow('CANCELLED_UNSENT')
        expect(provider.complete).not.toHaveBeenCalled(); expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 0n, reserved: 0n })
        await gateway.execute({ scope: admitted.scope, request: { ...modelRequest, attempt: 1 } })
        expect(provider.complete).toHaveBeenCalledTimes(1)
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(2)
    })
    it('uses the exact BYOK key for model and native calls, charges only base and reserves no managed dollars', async () => {
        await configure(); const configId = apId()
        await ds.getRepository(AIProviderEntity).insert({ id: configId, platformId: actor.platformId, provider: 'deepseek', displayName: 'Inclusive exact key', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-inclusive-exact-byok-key-not-real' }), config: {}, status: 'active', enabledForChat: false, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
        const admitted = await root('byok', configId), execute = vi.fn(successful), provider = modelProvider()
        await createHostedAiGateway({ dataSource: ds, provider }).execute({ scope: admitted.scope, request: { ...modelRequest, payer: { type: 'byok', configId }, model: 'deepseek-flash' } })
        await createHostedNativeTools({ dataSource: ds, provider: { execute } }).execute({ scope: admitted.scope, request: nativeRequest('search', { type: 'byok', configId }) })
        expect(execute.mock.calls[0][0].apiKey).toBe('synthetic-inclusive-exact-byok-key-not-real')
        expect(provider.complete.mock.calls[0][0].apiKey).toBe('synthetic-inclusive-exact-byok-key-not-real')
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await ds.getRepository(HostingReservationEntity).countBy({ rootReservationId: admitted.reservation.id })).toBe(0)
        expect(await ds.getRepository(HostingDailyBudgetEntity).count()).toBe(0)
    })
})

async function uncertainReceipt() {
    const admitted = await root()
    await settle(admitted.reservation.id, 600n)
    const reservation = await reserve(admitted.reservation.id, 5000n), claim = await ledger().claimManagedCall({ actor, reservationId: reservation.id }), now = new Date(), expired = new Date(Date.now() - 1000)
    await ledger().markUncertain({ platformId: actor.platformId, reservationId: reservation.id, dispatchId: claim.dispatchId! })
    await ds.getRepository(HostingDispatchEntity).update({ id: admitted.segmentId }, { state: 'uncertain', completionStatus: EngineResponseStatus.INTERNAL_ERROR, leaseUntil: expired })
    const call = await ds.getRepository(HostingModelCallEntity).save({ id: apId(), platformId: actor.platformId, projectId, segmentId: admitted.segmentId, rootReservationId: admitted.reservation.id, admissionId: admitted.scope.admissionId, identityId: actor.identityId, callKey: 'inclusive:receipt', attempt: 0, requestHash: 'b'.repeat(64), payer: 'managed', configId: null, credentialFingerprint: 'c'.repeat(64), model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions', state: 'uncertain', reservationId: reservation.id, dispatchId: claim.dispatchId!, fence: apId(), budgetDay: reservation.day, quote: { version: 'fixture', model: 'deepseek-flash', validFrom: new Date(now.getTime() - 60000).toISOString(), validUntil: new Date(now.getTime() + 60000).toISOString(), rates: { cacheHit: 100000, cacheMiss: 200000, output: 400000 }, ceiling: { cacheHit: 100000, cacheMiss: 200000, output: 400000 } }, sentAt: now, leaseUntil: expired, inputTokenBound: 10000 })
    const draft: ChargeResolutionDraftInput = { platformId: actor.platformId, rootReservationId: admitted.reservation.id, outcome: 'verified_usage', supplierRequestId: 'inclusive-receipt', supplierCreatedAt: now.toISOString(), usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, completion_tokens: 1000 }, reason: 'Investigated synthetic outcome', evidenceReference: 'Synthetic authoritative usage receipt' }
    return { admitted, reservation, call, draft }
}

describe('V4 audited charge resolution', () => {
    it('previews the aggregate root change, settles original expired/revoked grant, and replays the audit once', async () => {
        const fixture = await uncertainReceipt(), original = await grant(), service = createHostedChargeResolution({ dataSource: ds })
        expect(original).toMatchObject({ consumed: 1n, reserved: 3n })
        await ds.getRepository(HostingGrantEntity).update({ id: original.id }, { validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() - 1000), revokedAt: new Date() })
        const preview = await service.preview({ actor, callId: fixture.call.id, input: fixture.draft })
        // 600 settled + 600 verified fits the base Credit, so this receipt has no marginal debit.
        expect(preview.preview).toMatchObject({ actualMicroUsd: '600', actualCredits: '0', releasedCredits: '3', creditScope: 'execution_root', rootConsumedCredits: '1', rootReservedCredits: '0', rootTotalCredits: '1' })
        const input = { ...fixture.draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() }
        const first = await service.resolve({ actor, callId: fixture.call.id, input }), replay = await service.resolve({ actor, callId: fixture.call.id, input })
        expect(replay).toMatchObject({ replayed: true, auditId: first.auditId })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: original.id })).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 1200n, reserved: 0n })
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.reservation.id })).toMatchObject({ actualAmount: 0n, actualSupplierMicroUsd: 600n })
    })
    it('invalidates a preview when a sibling supplier hold settles, even though target call revision is unchanged', async () => {
        const fixture = await uncertainReceipt()
        // Seed a legitimately admitted sibling from before the target became uncertain.
        await ds.getRepository(HostingReservationEntity).update({ id: fixture.reservation.id }, { state: 'running' })
        const sibling = await reserve(fixture.admitted.reservation.id, 750n), claim = await ledger().claimManagedCall({ actor, reservationId: sibling.id })
        await ds.getRepository(HostingReservationEntity).update({ id: fixture.reservation.id }, { state: 'uncertain' })
        const service = createHostedChargeResolution({ dataSource: ds }), preview = await service.preview({ actor, callId: fixture.call.id, input: fixture.draft })
        const input = { ...fixture.draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() }
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: sibling.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 750n })
        await expect(service.resolve({ actor, callId: fixture.call.id, input })).rejects.toThrow('CONFLICT')
        const fresh = await service.preview({ actor, callId: fixture.call.id, input: fixture.draft })
        expect(fresh.preview.expectedRevision).toBe(preview.preview.expectedRevision)
        expect(fresh.preview.expectedState).not.toBe(preview.preview.expectedState)
        expect(fresh.preview).toMatchObject({ actualCredits: '1', rootConsumedCredits: '2', rootReservedCredits: '0', rootTotalCredits: '2' })
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: fixture.reservation.id })).toMatchObject({ state: 'uncertain' })
        await service.resolve({ actor, callId: fixture.call.id, input: { ...fixture.draft, expectedRevision: fresh.preview.expectedRevision, expectedState: fresh.preview.expectedState, requestKey: apId() } })
        expect(await grant()).toMatchObject({ consumed: 2n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 1950n, reserved: 0n })
    })
    it('invalidates a preview when only the persisted root meter revision changes', async () => {
        const fixture = await uncertainReceipt(), service = createHostedChargeResolution({ dataSource: ds })
        const preview = await service.preview({ actor, callId: fixture.call.id, input: fixture.draft })
        const input = { ...fixture.draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() }
        const meter = await ds.getRepository(HostingRootCreditUsageEntity).findOneByOrFail({ id: fixture.admitted.reservation.id })
        await ds.getRepository(HostingRootCreditUsageEntity).update({ id: meter.id }, { revision: meter.revision + 1 })
        await expect(service.resolve({ actor, callId: fixture.call.id, input })).rejects.toThrow('CONFLICT')
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 3n })
    })
    it('returns known unsent supplier liability without refunding the consumed base Credit', async () => {
        const fixture = await uncertainReceipt(), service = createHostedChargeResolution({ dataSource: ds })
        const draft: ChargeResolutionDraftInput = { platformId: actor.platformId, rootReservationId: fixture.admitted.reservation.id, outcome: 'confirmed_not_sent', reason: 'Synthetic no-send verification', evidenceReference: 'Supplier confirms the request was never received' }
        const preview = await service.preview({ actor, callId: fixture.call.id, input: draft })
        const input = { ...draft, expectedRevision: preview.preview.expectedRevision, expectedState: preview.preview.expectedState, requestKey: apId() }
        await service.resolve({ actor, callId: fixture.call.id, input }); await service.resolve({ actor, callId: fixture.call.id, input })
        expect(await grant()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 600n, reserved: 0n })
    })
})

describe('V4 migration and coexistence with historical additive roots', () => {
    async function historicalRoot(version = V3) {
        const admitted = await root()
        // Explicit historical fixture, never a production rewrite or the V4 path under test.
        await ds.getRepository(HostingRootCreditUsageEntity).delete({ id: admitted.reservation.id })
        await ds.getRepository(HostingReservationEntity).update({ id: admitted.reservation.id }, { accountingVersion: version })
        return admitted
    }
    it.each(['single-credits-500-microusd-v1', 'single-credits-250-microusd-v2', V3])('keeps later fresh children of %s additive at V3 while a new root is inclusive', async version => {
        const legacy = await historicalRoot(version), old = await reserve(legacy.reservation.id, 750n), claim = await ledger().claimManagedCall({ actor, reservationId: old.id })
        expect(old).toMatchObject({ accountingVersion: V3, amount: 1n, microUsdPerCredit: 1500n })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: old.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 750n })
        await ledger().finishExecution({ platformId: actor.platformId, reservationId: legacy.reservation.id, dispatchId: legacy.dispatchId })
        const inclusive = await root(); await settle(inclusive.reservation.id, 750n); await settle(inclusive.reservation.id, 750n)
        expect(await grant()).toMatchObject({ consumed: 3n, reserved: 0n })
        expect(await budget()).toMatchObject({ consumed: 2250n, reserved: 0n })
    })
    it('round-trips the additive migration without rewriting old reservations, stored rates, grants, supplier dollars or ledger history', async () => {
        const legacy = await historicalRoot()
        const completedV2 = await reserve(legacy.reservation.id, 5000n), v2Claim = await ledger().claimManagedCall({ actor, reservationId: completedV2.id })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: completedV2.id, dispatchId: v2Claim.dispatchId!, actualCostMicroUsd: 600n })
        await ds.getRepository(HostingReservationEntity).update({ id: completedV2.id }, { accountingVersion: 'single-credits-250-microusd-v2', microUsdPerCredit: 250n, amount: 20n, actualAmount: 3n })
        const completedV3 = await reserve(legacy.reservation.id, 750n), v3Claim = await ledger().claimManagedCall({ actor, reservationId: completedV3.id })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: completedV3.id, dispatchId: v3Claim.dispatchId!, actualCostMicroUsd: 750n })
        const old = await reserve(legacy.reservation.id, 5000n), claim = await ledger().claimManagedCall({ actor, reservationId: old.id })
        await ledger().markUncertain({ platformId: actor.platformId, reservationId: old.id, dispatchId: claim.dispatchId! })
        await ds.getRepository(HostingReservationEntity).update({ id: old.id }, { accountingVersion: 'single-credits-500-microusd-v1', microUsdPerCredit: 500n, amount: 10n })
        await ds.getRepository(HostingGrantEntity).update({ id: old.grantId }, { consumed: 5n, reserved: 10n })
        const snapshot = async () => ({ reservations: await ds.getRepository(HostingReservationEntity).find({ order: { id: 'ASC' } }), grants: await ds.getRepository(HostingGrantEntity).find({ order: { id: 'ASC' } }), budgets: await ds.getRepository(HostingDailyBudgetEntity).find({ order: { id: 'ASC' } }), entries: await ds.getRepository(HostingLedgerEntity).find({ order: { id: 'ASC' } }) })
        const before = await snapshot(), runner = ds.createQueryRunner(), migration = new SydekyksInclusiveCredits1914000000000()
        try { await runner.startTransaction(); await migration.down(runner); await migration.up(runner); await runner.commitTransaction() }
        finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release() }
        expect(await snapshot()).toEqual(before)
        expect(await ds.getRepository(HostingRootCreditUsageEntity).count()).toBe(0)
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: old.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 1200n })
        await ledger().finishExecution({ platformId: actor.platformId, reservationId: legacy.reservation.id, dispatchId: legacy.dispatchId })
        // The next ordinary admission must still use V4 after the round-trip.
        await root()
    })
    it.each(['managed', 'byok'] as const)('guards rollback as soon as a V4 %s root exists', async payer => {
        await root(payer)
        const runner = ds.createQueryRunner()
        try { await expect(new SydekyksInclusiveCredits1914000000000().down(runner)).rejects.toThrow('ROLLBACK_REQUIRES_BACKUP_RESTORE') }
        finally { await runner.release() }
        expect((await grant()).consumed).toBe(1n)
    })
    it.each([null, 'single-credits-500-microusd-v1', 'single-credits-250-microusd-v2', V3])('rejects zero managed-child amount under historical accounting version %s', async accountingVersion => {
        const admitted = await root(), child = await reserve(admitted.reservation.id, 750n)
        // NULL must fail explicitly: a SQL CHECK that evaluates to NULL would otherwise accept this row.
        await expect(ds.getRepository(HostingReservationEntity).update({ id: child.id }, { accountingVersion, amount: 0n })).rejects.toThrow()
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: child.id })).toMatchObject({ accountingVersion: V4, amount: 0n, actualAmount: 0n })
    })
    it('allows zero only for V4 managed children and requires a positive root conversion snapshot', async () => {
        const admitted = await root(), child = await reserve(admitted.reservation.id, 750n)
        await expect(ds.getRepository(HostingReservationEntity).update({ id: admitted.reservation.id }, { amount: 0n })).rejects.toThrow()
        await expect(ds.getRepository(HostingReservationEntity).update({ id: admitted.reservation.id }, { microUsdPerCredit: 0n })).rejects.toThrow()
        await expect(ds.getRepository(HostingReservationEntity).update({ id: child.id }, { actualAmount: 1n })).rejects.toThrow()
        await expect(ds.getRepository(HostingRootCreditUsageEntity).update({ id: admitted.reservation.id }, { microUsdPerCredit: 0n })).rejects.toThrow()
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: child.id })).toMatchObject({ amount: 0n, accountingVersion: V4 })
    })
})
