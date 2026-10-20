import { readFileSync } from 'node:fs'
import { AIProviderName, apId } from '@activepieces/core-utils'
import { AgentConversationStatus, AgentEvent, AgentEventType, AgentRunSource, EngineResponseStatus, ExecuteAgentRunJobData, hostingCatalog, LATEST_JOB_DATA_SCHEMA_VERSION, WorkerJobType } from '@activepieces/shared'
import { APICallError } from 'ai'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { SydekyksCreditRateV21905000000000 } from '../../src/app/database/migration/postgres/1905000000000-SydekyksCreditRateV2'
import { SydekyksUnifiedCredits1903000000000 } from '../../src/app/database/migration/postgres/1903000000000-SydekyksUnifiedCredits'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { createHostedAiGateway } from '../../src/app/hosting/hosting-ai-gateway'
import { hostedAiInputBound } from '../../src/app/hosting/hosting-ai-policy'
import { hostedAiCredits, hostedCreditLiability, HOSTED_MAX_ROOT_CREDITS } from '../../src/app/hosting/hosting-credit-policy'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingDailyBudgetEntity, HostingGrantEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedExecution } from '../../src/app/hosting/hosting-execution'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { saveManagedSettings } from '../../src/app/hosting/hosting-managed-settings'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPricing, hostedPricingView } from '../../src/app/hosting/hosting-pricing'
import { PRICING_CALENDAR } from '../../src/app/hosting/hosting-pricing-source'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { sydApprovalGate } from '../../src/app/syd/copilot/approval-gate'
import { SydConversationEntity } from '../../src/app/syd/copilot/models/conversation.entity'
import { UserEntity } from '../../src/app/user/user-entity'
import { executeAgentRunJob } from '../../../worker/src/lib/execute/jobs/ee/agent/execute-agent-run'
import * as agentTurnRuntime from '../../../worker/src/lib/execute/jobs/ee/agent/run-agent-turn'
import type { JobContext } from '../../../worker/src/lib/execute/types'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, actor: HostingActor, projectId: string
const ledger = () => createHostedLedger({ dataSource: ds })
const currentGrant = async () => ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'execution' })
const balance = async () => (await ledger().balance({ actor })).find(grant => grant.meter === 'execution')!
const day = () => new Date().toISOString().slice(0, 10)
const request = { callKey: 'test:0', attempt: 0, payer: { type: 'managed' as const }, model: 'sydekyks' as const, messages: [{ role: 'user' as const, content: 'Synthetic input' }], max_tokens: 1000 }

beforeAll(async () => { ds = await migratedHostedPGlite() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
beforeEach(async () => {
    // Cancellation transport is outside this ledger/unit scope; runtime tests use real Redis.
    vi.spyOn(sydApprovalGate, 'isCancelled').mockResolvedValue(false)
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Fixture', tokenVersion: 'initial' })
    const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-unified-subject-at-least32characters' }), identityId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', identityId)
    actor = { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }
    projectId = home.projectId!
})
async function root(payer: 'managed' | 'byok' = 'managed') {
    const reservation = await ledger().reserveExecution({ actor, projectId, key: apId(), payer })
    const claim = await ledger().claimExecution({ actor, reservationId: reservation.id })
    const admissionId = apId()
    await ds.getRepository(HostingDispatchEntity).insert({ id: apId(), platformId: actor.platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 'x'.repeat(64), state: 'running', rootKey: apId(), reservationId: reservation.id, admissionId, dispatchId: claim.dispatchId, leaseUntil: new Date(Date.now() + 60000) })
    return { reservation, dispatchId: claim.dispatchId!, scope: { admissionId, platformId: actor.platformId, projectId } }
}
async function reserve(rootReservationId: string, cost: bigint, key = apId()) {
    return ledger().reserveManagedCall({ actor, rootReservationId, key, maxCostMicroUsd: cost })
}
async function settled(rootReservationId: string, held: bigint, actual: bigint, key = apId()) {
    const call = await reserve(rootReservationId, held, key)
    const claim = await ledger().claimManagedCall({ actor, reservationId: call.id })
    await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: call.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: actual })
    return { call, dispatchId: claim.dispatchId! }
}
async function configureManaged() {
    await saveManagedSettings({ dataSource: ds, actor, input: { expectedRevision: 0, expectedGlobalRevision: 0, requestKey: apId(), mode: 'set', model: 'deepseek-flash', credentialAction: 'replace', apiKey: 'synthetic-unified-provider-key-not-real' } })
    const html = readFileSync(new URL('../fixtures/hosting-official-pricing.html', import.meta.url), 'utf8')
    const pricing = createHostedPricing({ dataSource: ds, fetchSource: async () => ({ html, date: new Date().toUTCString(), age: '0' }) })
    await pricing.observe()
    const current = await tx.run({ dataSource: ds, fn: async manager => hostedPricingView(manager, await tx.now(manager)) })
    await pricing.approve({ actor, input: { expectedRevision: current.revision, observationId: current.observationId!, termsHash: current.termsHash!, requestKey: apId(), validUntil: PRICING_CALENDAR.until, calendarVersion: PRICING_CALENDAR.version } })
}
async function chatByok(payer: 'managed' | 'byok' = 'byok') {
    const user = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: actor.identityId, platformId: actor.platformId }), configId = apId(), runId = apId(), conversationId = apId()
    await ds.getRepository(AIProviderEntity).insert({ id: configId, platformId: actor.platformId, provider: 'deepseek', displayName: 'Synthetic chat BYOK', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-chat-byok-key-not-real' }), config: {}, status: 'active', enabledForChat: false, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
    await ds.getRepository(SydConversationEntity).insert({ id: conversationId, platformId: actor.platformId, projectId, userId: user.id, source: AgentRunSource.CHAT, activeRunId: runId, status: AgentConversationStatus.IDLE })
    const data: ExecuteAgentRunJobData = { schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_AGENT_RUN, platformId: actor.platformId, projectId, conversationId, runId, userId: user.id, source: AgentRunSource.CHAT, userMessage: 'Synthetic BYOK chat', modelName: payer === 'byok' ? 'deepseek-flash' : 'sydekyks', provider: payer === 'byok' ? AIProviderName.DEEPSEEK : AIProviderName.ACTIVEPIECES, ...(payer === 'byok' ? { providerConfigId: configId } : {}) }
    const delivery = { queueName: 'synthetic-chat-byok', jobId: runId, data, queueToken: 'synthetic-chat-worker-lock' }, execution = createHostedExecution({ dataSource: ds })
    const origin = { type: 'user' as const, userId: user.id, tokenVersion: actor.tokenVersion }
    await execution.prepare({ ...delivery, origin })
    return { configId, conversationId, execution, delivery, origin }
}

function completion(model: string, prompt = 4000, output = 1000) {
    return { status: 200, data: { id: 'private-upstream', model, created: Math.floor(Date.now() / 1000), object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic response' } }], usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: prompt } } }
}

describe('single Credits accounting', () => {
    it('preserves v1 holds through the additive migration and settles at their recorded rate once', async () => {
        const admitted = await root(), grant = await currentGrant(), old = await reserve(admitted.reservation.id, 5000n)
        await ds.getRepository(HostingReservationEntity).update({ id: admitted.reservation.id }, { accountingVersion: 'single-credits-500-microusd-v1' })
        await ds.getRepository(HostingReservationEntity).update({ id: old.id }, { accountingVersion: 'single-credits-500-microusd-v1', microUsdPerCredit: 500n, amount: 10n })
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { reserved: 10n })
        const claim = await ledger().claimManagedCall({ actor, reservationId: old.id })
        await ledger().markUncertain({ platformId: actor.platformId, reservationId: old.id, dispatchId: claim.dispatchId! })
        const before = await ds.getRepository(HostingReservationEntity).findBy({ platformId: actor.platformId })
        const runner = ds.createQueryRunner(), migration = new SydekyksCreditRateV21905000000000()
        try {
            await runner.startTransaction(); await migration.down(runner); await migration.up(runner); await runner.commitTransaction()
        }
        finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release() }
        expect(await ds.getRepository(HostingReservationEntity).findBy({ platformId: actor.platformId })).toEqual(before)
        const retry = await reserve(admitted.reservation.id, 5000n, old.key)
        expect(retry).toMatchObject({ id: old.id, amount: 10n, microUsdPerCredit: 500n })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: old.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 1200n })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: old.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 1200n })
        expect(await balance()).toMatchObject({ consumed: 4n, reserved: 0n })
        const fresh = await settled(admitted.reservation.id, 1200n, 1200n)
        expect(fresh.call).toMatchObject({ accountingVersion: 'single-credits-250-microusd-v2', microUsdPerCredit: 250n, amount: 5n })
        expect(await balance()).toMatchObject({ consumed: 9n, reserved: 0n })
        const rollback = ds.createQueryRunner()
        try { await expect(migration.down(rollback)).rejects.toThrow('CREDIT_RATE_ROLLBACK_REQUIRES_BACKUP_RESTORE') }
        finally { await rollback.release() }
    })
    it('counts old Credit-denominated exposure unchanged alongside new-rate calls at the root limit', async () => {
        const admitted = await root(), grant = await currentGrant()
        const common = { platformId: actor.platformId, projectId, identityId: actor.identityId, grantId: grant.id, kind: 'managed_ai' as const, payer: 'managed' as const, rootReservationId: admitted.reservation.id, day: day(), accountingVersion: 'single-credits-500-microusd-v1', microUsdPerCredit: 500n, dispatchId: apId() }
        await ds.getRepository(HostingReservationEntity).insert([
            { ...common, id: apId(), key: 'old:settled', state: 'settled', amount: 300n, actualAmount: 300n, supplierMaxMicroUsd: 150000n, actualSupplierMicroUsd: 150000n },
            { ...common, id: apId(), key: 'old:held', state: 'running', amount: 697n, actualAmount: null, supplierMaxMicroUsd: 348500n },
        ])
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: 10000n, consumed: 301n, reserved: 697n })
        await settled(admitted.reservation.id, 500n, 500n)
        expect(await balance()).toMatchObject({ consumed: 303n, reserved: 697n })
        await expect(reserve(admitted.reservation.id, 1n)).rejects.toThrow('RUN_CREDIT_LIMIT')
    })
    it('rounds each verified AI charge upward, handles zero and rejects invalid cost', () => {
        expect([0n, 1n, 249n, 250n, 251n, 499n, 500n, 501n, 1200n, 2400n].map(value => hostedAiCredits(value))).toEqual([0n, 1n, 1n, 1n, 2n, 2n, 2n, 3n, 5n, 10n])
        expect(() => hostedAiCredits(-1n)).toThrow('INVALID_AMOUNT')
        expect(() => hostedAiCredits(1n, 0n)).toThrow('INVALID_AMOUNT')
    })
    it('charges the execution grant only and leaves old AI grants untouched even when exhausted', async () => {
        const legacy = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'managed_ai' })
        await ds.getRepository(HostingGrantEntity).update({ id: legacy.id }, { consumed: legacy.amount })
        const admitted = await root(), before = await currentGrant()
        const { call, dispatchId } = await settled(admitted.reservation.id, 5000n, 2400n, 'managed:first')
        expect(call.grantId).toBe(before.id); expect(call.amount).toBe(20n); expect(call.supplierMaxMicroUsd).toBe(5000n)
        expect(await balance()).toMatchObject({ consumed: 11n, reserved: 0n, available: before.amount - 11n })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: legacy.id })).toMatchObject({ consumed: legacy.amount, reserved: 0n })
        const budget = await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: day() })
        expect(budget).toMatchObject({ consumed: 2400n, reserved: 0n })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: call.id, dispatchId, actualCostMicroUsd: 2400n })
        expect((await currentGrant()).consumed).toBe(11n)
        await expect(ledger().settleManagedCall({ platformId: actor.platformId, reservationId: call.id, dispatchId, actualCostMicroUsd: 2401n })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    })
    it('reserves before sending and refuses a second spender without an additional hold', async () => {
        const grant = await currentGrant()
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: 3n })
        const admitted = await root(), held = await reserve(admitted.reservation.id, 500n, 'held:first')
        expect((await balance()).available).toBe(0n)
        await expect(reserve(admitted.reservation.id, 1n, 'held:second')).rejects.toThrow('CREDITS_EXHAUSTED')
        const duplicate = await reserve(admitted.reservation.id, 500n, 'held:first')
        expect(duplicate.id).toBe(held.id); expect((await currentGrant()).reserved).toBe(2n)
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: held.id })
        expect((await balance()).available).toBe(2n)
        await reserve(admitted.reservation.id, 500n, 'held:after-release')
    })
    it('retains uncertain holds and bounds root cumulative settled and unresolved spend', async () => {
        const admitted = await root()
        await ds.getRepository(HostingGrantEntity).update({ id: admitted.reservation.grantId }, { amount: 10000n })
        await ds.getRepository(HostingReservationEntity).update({ id: admitted.reservation.id }, { maxRootCredits: 14n })
        await settled(admitted.reservation.id, 1500n, 1500n)
        const held = await reserve(admitted.reservation.id, 1500n)
        await expect(reserve(admitted.reservation.id, 1000n)).rejects.toThrow('RUN_CREDIT_LIMIT')
        const claim = await ledger().claimManagedCall({ actor, reservationId: held.id })
        await ledger().markUncertain({ platformId: actor.platformId, reservationId: held.id, dispatchId: claim.dispatchId! })
        await expect(reserve(admitted.reservation.id, 1n)).rejects.toThrow('OUTCOME_UNCERTAIN')
        expect(await balance()).toMatchObject({ consumed: 7n, reserved: 6n })
        await expect(ledger().cancelUnsent({ platformId: actor.platformId, reservationId: held.id })).rejects.toThrow('INVALID_TRANSITION')
        expect(HOSTED_MAX_ROOT_CREDITS).toBe(1000n)
    })
    it('keeps supplier emergency budget in dollars independently of the Credit conversion', async () => {
        const admitted = await root()
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: day(), limit: 499n, reserved: 0n, consumed: 0n })
        await expect(reserve(admitted.reservation.id, 500n)).rejects.toThrow('OPERATOR_BUDGET_EXHAUSTED')
        expect((await currentGrant()).reserved).toBe(0n)
    })
    it('settles zero verified spend, releases only known unsent holds, and suspends a breached supplier bound', async () => {
        const admitted = await root()
        await settled(admitted.reservation.id, 1000n, 0n)
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
        await settled(admitted.reservation.id, 500n, 501n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).status).toBe('suspended')
        expect((await currentGrant()).consumed).toBe(4n)
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: day() })).consumed).toBe(501n)
    })
    it('migrates unresolved legacy holds without changing old financial quantities or charging completed history again', async () => {
        const admitted = await root(), oldGrant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'managed_ai' })
        await ds.getRepository(HostingReservationEntity).update({ id: admitted.reservation.id }, { accountingVersion: null, maxRootCredits: null })
        const common = { platformId: actor.platformId, projectId, identityId: actor.identityId, grantId: oldGrant.id, kind: 'managed_ai' as const, payer: 'managed' as const, rootReservationId: admitted.reservation.id, day: day(), dispatchId: apId(), accountingVersion: null }
        const pendingId = apId(), completedId = apId()
        await ds.getRepository(HostingReservationEntity).insert([
            { ...common, id: pendingId, key: 'legacy:migration-pending', state: 'uncertain', amount: 1500n, actualAmount: null },
            { ...common, id: completedId, key: 'legacy:migration-completed', state: 'settled', amount: 1000n, actualAmount: 500n },
        ])
        await ds.getRepository(HostingGrantEntity).update({ id: oldGrant.id }, { reserved: 1500n, consumed: 500n })
        const runner = ds.createQueryRunner(), migration = new SydekyksUnifiedCredits1903000000000()
        try {
            await runner.startTransaction()
            await migration.down(runner)
            await migration.up(runner)
            await new SydekyksCreditRateV21905000000000().up(runner)
            await runner.commitTransaction()
        }
        finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction()
            await runner.release()
        }
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: oldGrant.id })).toMatchObject({ reserved: 1500n, consumed: 500n, amount: oldGrant.amount })
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: pendingId })).toMatchObject({ amount: 1500n, actualAmount: null, accountingVersion: null, legacyCreditGrantId: admitted.reservation.grantId, microUsdPerCredit: 500n })
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: completedId })).legacyCreditGrantId).toBeNull()
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 3n })
        const rollback = ds.createQueryRunner()
        try { await expect(migration.down(rollback)).rejects.toThrow('ROLLBACK_REQUIRES_BACKUP_RESTORE') }
        finally { await rollback.release() }
    })
    it('settles with the conversion snapshot on the held call rather than current catalog pricing', async () => {
        const admitted = await root(), call = await reserve(admitted.reservation.id, 1000n)
        // Simulate a call prepared under another explicitly reviewed conversion.
        await ds.getRepository(HostingReservationEntity).update({ id: call.id }, { microUsdPerCredit: 1000n })
        const claim = await ledger().claimManagedCall({ actor, reservationId: call.id })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: call.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 501n })
        expect((await currentGrant()).consumed).toBe(2n)
    })
    it('keeps pending legacy liabilities reserved and consumes them after old-unit settlement without converting grants', async () => {
        const admitted = await root(), oldGrant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'managed_ai' })
        const id = apId(), dispatchId = apId()
        await ds.getRepository(HostingReservationEntity).insert({ id, platformId: actor.platformId, projectId, identityId: actor.identityId, grantId: oldGrant.id, key: 'legacy:pending', kind: 'managed_ai', payer: 'managed', state: 'uncertain', rootReservationId: admitted.reservation.id, day: day(), amount: 1500n, actualAmount: null, dispatchId, accountingVersion: null, legacyCreditGrantId: admitted.reservation.grantId, microUsdPerCredit: 500n })
        await ds.getRepository(HostingGrantEntity).update({ id: oldGrant.id }, { reserved: 1500n })
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: day(), reserved: 1500n, consumed: 0n, limit: 1000000n })
        // Pre-snapshot legacy rows retain the original 500-microUSD fallback.
        await ds.getRepository(HostingReservationEntity).update({ id }, { microUsdPerCredit: null })
        expect(await hostedCreditLiability(ds.manager, admitted.reservation.grantId)).toEqual({ reserved: 3n, consumed: 0n })
        expect(await balance()).toMatchObject({ reserved: 3n, consumed: 1n })
        await ledger().settleManagedCall({ platformId: actor.platformId, reservationId: id, dispatchId, actualCostMicroUsd: 501n })
        expect(await balance()).toMatchObject({ reserved: 0n, consumed: 3n })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: oldGrant.id })).toMatchObject({ amount: oldGrant.amount, reserved: 0n, consumed: 501n })
        expect((await currentGrant()).consumed).toBe(1n)
    })
})

describe('full gateway Credit journey', () => {
    it('bounds tiny requests without reserving the full model context and includes tools/schema bytes', () => {
        const small = hostedAiInputBound(request)
        const tools = [{ type: 'function' as const, function: { name: 'demo', description: 'x'.repeat(1000), parameters: { type: 'object', properties: { content: { type: 'string' } } } } }]
        expect(small).toBeLessThan(10000)
        expect(hostedAiInputBound({ ...request, tools })).toBeGreaterThan(small + 4000)
        expect(() => hostedAiInputBound({ ...request, messages: [{ role: 'user', content: 'x'.repeat(65536) }] })).toThrow('REQUEST_LIMIT')
    })
    it('charges one shared balance, replays settled calls once and denies calls after exhaustion before provider send', async () => {
        await configureManaged()
        const admitted = await root(), complete = vi.fn(async ({ request: sent }: { request: { model: string } }) => completion(sent.model))
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic', endpoint: 'diagnostic://no-network', complete } })
        const first = await gateway.execute({ scope: admitted.scope, request })
        expect(first.model).toBe('sydekyks')
        await gateway.execute({ scope: admitted.scope, request })
        expect(complete).toHaveBeenCalledTimes(1)
        const saved = await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ admissionId: admitted.scope.admissionId })
        const credits = hostedAiCredits(BigInt(saved.actualMicroUsd!))
        expect((await currentGrant()).consumed).toBe(1n + credits)
        const grant = await currentGrant()
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: grant.consumed })
        await expect(gateway.execute({ scope: admitted.scope, request: { ...request, callKey: 'new:exhausted' } })).rejects.toThrow('CREDITS_EXHAUSTED')
        expect(complete).toHaveBeenCalledTimes(1)
    })
    it('uses BYOK without any managed-AI charge or supplier pricing/credential requirement', async () => {
        const admitted = await root('byok'), configId = apId()
        await ds.getRepository(AIProviderEntity).insert({ id: configId, platformId: actor.platformId, provider: 'deepseek', displayName: 'Exact client key', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-byok-unified-not-real-key' }), config: {}, status: 'active', enabledForChat: false, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
        const complete = vi.fn(async ({ request: sent }: { request: { model: string } }) => completion(sent.model))
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic', endpoint: 'diagnostic://no-network', complete } })
        await gateway.execute({ scope: admitted.scope, request: { ...request, model: 'deepseek-flash', payer: { type: 'byok', configId } } })
        expect((await currentGrant()).consumed).toBe(1n)
        expect(await ds.getRepository(HostingDailyBudgetEntity).count()).toBe(0)
        expect(complete).toHaveBeenCalledTimes(1)
        expect((await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ admissionId: admitted.scope.admissionId })).reservationId).toBeNull()
    })
    it('admits an actual BYOK chat root, reaches the gateway and settles only one execution Credit', async () => {
        const value = await chatByok(), admissionId = await value.execution.admit(value.delivery)
        const fence = { ...value.delivery, admissionId, connectionId: 'synthetic-chat-worker' }
        expect(await value.execution.start(fence)).toBe(true)
        await ds.getRepository(SydConversationEntity).update({ id: value.conversationId }, { status: AgentConversationStatus.STREAMING })
        const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId })
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: dispatch.reservationId! })).payer).toBe('byok')
        const complete = vi.fn(async ({ request: sent }: { request: { model: string } }) => completion(sent.model))
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic', endpoint: 'diagnostic://no-network', complete } })
        await gateway.execute({ scope: { admissionId, platformId: actor.platformId, projectId }, request: { ...request, callKey: 'copilot:0', model: 'deepseek-flash', payer: { type: 'byok', configId: value.configId } } })
        await value.execution.complete({ ...fence, status: EngineResponseStatus.OK })
        expect(complete).toHaveBeenCalledTimes(1)
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: dispatch.reservationId! })).state).toBe('settled')
        expect(await ds.getRepository(HostingDailyBudgetEntity).count()).toBe(0)
    })

    it.each(['before-admission', 'before-start'] as const)('refuses removed BYOK chat keys %s without charging and closes the matching idle conversation', async when => {
        const value = await chatByok()
        let admissionId: string | null = null
        if (when === 'before-start') admissionId = await value.execution.admit(value.delivery)
        await ds.getRepository(AIProviderEntity).delete({ id: value.configId })
        if (admissionId) expect(await value.execution.start({ ...value.delivery, admissionId, connectionId: 'never-started-chat-worker' })).toBe(false)
        else await expect(value.execution.admit(value.delivery)).rejects.toThrow('BYOK_SCOPE_DENIED')
        expect(await balance()).toMatchObject({ consumed: 0n, reserved: 0n })
        expect((await ds.getRepository(SydConversationEntity).findOneByOrFail({ id: value.conversationId })).status).toBe(AgentConversationStatus.ERROR)
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ platformId: actor.platformId })).toBe(0)
        expect((await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ platformId: actor.platformId })).state).toBe('cancelled')
    })

    it('closes an idle zero-Credit chat without any execution or supplier reservation', async () => {
        const value = await chatByok(), grant = await currentGrant()
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: 0n })
        await expect(value.execution.admit(value.delivery)).rejects.toThrow('CREDITS_EXHAUSTED')
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: actor.platformId })).toBe(0)
        expect((await ds.getRepository(SydConversationEntity).findOneByOrFail({ id: value.conversationId })).status).toBe(AgentConversationStatus.ERROR)
    })

    it('does not overwrite a newer conversation run when cancelling an older unsent chat', async () => {
        const value = await chatByok(), nextRunId = apId()
        await ds.getRepository(SydConversationEntity).update({ id: value.conversationId }, { activeRunId: nextRunId, status: AgentConversationStatus.IDLE })
        await expect(value.execution.admit(value.delivery)).rejects.toThrow('JOB_PROVENANCE_REQUIRED')
        expect(await ds.getRepository(SydConversationEntity).findOneByOrFail({ id: value.conversationId })).toMatchObject({ activeRunId: nextRunId, status: AgentConversationStatus.IDLE })
        expect((await currentGrant()).consumed).toBe(0n)
    })

    it('refuses a new chat attempt while a prior call in the same conversation remains uncertain', async () => {
        const value = await chatByok(), admissionId = await value.execution.admit(value.delivery)
        const fence = { ...value.delivery, admissionId, connectionId: 'synthetic-chat-worker' }
        await value.execution.start(fence)
        await ds.getRepository(SydConversationEntity).update({ id: value.conversationId }, { status: AgentConversationStatus.STREAMING })
        const complete = vi.fn(async () => { throw new Error('unknown supplier outcome') })
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic', endpoint: 'diagnostic://no-network', complete } })
        await expect(gateway.execute({ scope: { admissionId, platformId: actor.platformId, projectId }, request: { ...request, callKey: 'copilot:0', model: 'deepseek-flash', payer: { type: 'byok', configId: value.configId } } })).rejects.toThrow('OUTCOME_UNCERTAIN')
        const runId = apId(), next = { ...value.delivery, jobId: runId, data: { ...value.delivery.data, runId } }
        await ds.getRepository(SydConversationEntity).update({ id: value.conversationId }, { activeRunId: runId, status: AgentConversationStatus.IDLE })
        await value.execution.prepare({ ...next, origin: value.origin })
        await expect(value.execution.admit(next)).rejects.toThrow('OUTCOME_UNCERTAIN')
        expect((await currentGrant()).consumed).toBe(1n)
        expect(complete).toHaveBeenCalledTimes(1)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: actor.platformId, kind: 'execution' })).toBe(1)
        expect((await ds.getRepository(SydConversationEntity).findOneByOrFail({ id: value.conversationId })).status).toBe(AgentConversationStatus.ERROR)
    })

    it.each([
        { code: 'HOSTING_CREDITS_EXHAUSTED', status: 403, definitive: true },
        { code: 'HOSTING_RUN_CREDIT_LIMIT', status: 403, definitive: true },
        { code: 'HOSTING_OPERATOR_BUDGET_EXHAUSTED', status: 403, definitive: true },
        { code: 'HOSTING_AI_OUTCOME_UNCERTAIN', status: 403, definitive: false },
        { code: 'HOSTING_CREDITS_EXHAUSTED', status: 429, definitive: false },
    ])('settles actual worker catch-path $code/$status only for trusted definitive refusals', async ({ code, status, definitive }) => {
        vi.stubEnv('AP_SERVICE_MODE', 'hosted')
        const value = await chatByok('managed'), admissionId = await value.execution.admit(value.delivery)
        const fence = { ...value.delivery, admissionId, connectionId: 'synthetic-worker-catch' }
        expect(await value.execution.start(fence)).toBe(true)
        await ds.getRepository(SydConversationEntity).update({ id: value.conversationId }, { status: AgentConversationStatus.STREAMING })
        const internalApiUrl = 'http://127.0.0.1:1/api/'
        const error = new APICallError({ message: 'Forbidden', url: `${internalApiUrl}v1/engine/hosting-ai/copilot/chat/completions`, requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify({ code }), isRetryable: false })
        const turn = vi.spyOn(agentTurnRuntime, 'runAgentTurn').mockRejectedValue(error)
        const events: AgentEvent[] = []
        const logger = { child: () => logger, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {} }
        const ctx = { admissionId, internalApiUrl, engineToken: 'synthetic-worker-engine-token', log: logger, apiClient: {
            getAgentConfig: async () => ({ hosted: { protocol: 1, payer: { type: 'managed' }, model: 'sydekyks' }, credentials: { provider: AIProviderName.ACTIVEPIECES }, modelId: 'sydekyks', source: AgentRunSource.CHAT, aiTools: {}, tier: { id: 'synthetic' }, previousUiMessages: [], messages: [], projects: [], systemPrompt: 'Synthetic no-supplier test' }),
            saveAgentMessages: async () => { await ds.getRepository(SydConversationEntity).update({ id: value.conversationId, activeRunId: value.delivery.data.runId }, { status: AgentConversationStatus.ERROR }) },
            sendAgentEvent: async ({ event }: { event: AgentEvent }) => { events.push(event) },
            executeAgentTool: async () => ({ result: false }), heartbeatAgentConversation: async () => {},
        } } as unknown as JobContext
        if (definitive) {
            const result = await executeAgentRunJob.execute(ctx, value.delivery.data)
            expect(result.status).toBe(EngineResponseStatus.USER_FAILURE)
            await value.execution.complete({ ...fence, status: result.status })
        }
        else {
            await expect(executeAgentRunJob.execute(ctx, value.delivery.data)).rejects.toThrow('Forbidden')
            await value.execution.complete({ ...fence, status: EngineResponseStatus.INTERNAL_ERROR })
        }
        expect(turn).toHaveBeenCalledTimes(1)
        expect(events.map(event => event.type)).toEqual([AgentEventType.ERROR, AgentEventType.FINISHED])
        if (code === 'HOSTING_CREDITS_EXHAUSTED' && definitive) expect(events[0]).toMatchObject({ data: { message: expect.stringContaining('Not enough Credits') } })
        expect(JSON.stringify(events)).not.toContain('QUOTA_EXCEEDED')
        expect(JSON.stringify(events)).not.toContain('HOSTING_')
        expect((await ds.getRepository(SydConversationEntity).findOneByOrFail({ id: value.conversationId })).status).toBe(AgentConversationStatus.ERROR)
        const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId })
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: dispatch.reservationId! })).state).toBe(definitive ? 'settled' : 'uncertain')
        expect(await balance()).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ platformId: actor.platformId })).toBe(0)
        expect(await ds.getRepository(HostingDailyBudgetEntity).count()).toBe(0)
    })

    it('retains an uncertain supplier hold and refuses both explicit retry and another call key', async () => {
        await configureManaged()
        const admitted = await root(), complete = vi.fn(async () => { throw new Error('unknown network outcome') })
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic', endpoint: 'diagnostic://no-network', complete } })
        await expect(gateway.execute({ scope: admitted.scope, request })).rejects.toThrow('OUTCOME_UNCERTAIN')
        const held = (await balance()).reserved
        expect(held).toBeGreaterThan(0n)
        await expect(gateway.execute({ scope: admitted.scope, request: { ...request, attempt: 1 } })).rejects.toThrow('RETRY_DENIED')
        await expect(gateway.execute({ scope: admitted.scope, request: { ...request, callKey: 'new:blind-retry' } })).rejects.toThrow('OUTCOME_UNCERTAIN')
        expect(complete).toHaveBeenCalledTimes(1)
        expect((await balance()).reserved).toBe(held)
    })
    it('reserves again for an explicit retry only after cancellation proves the first request was unsent', async () => {
        await configureManaged()
        const admitted = await root(), complete = vi.fn(async ({ request: sent }: { request: { model: string } }) => completion(sent.model))
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic', endpoint: 'diagnostic://no-network', complete } })
        const controller = new AbortController(); controller.abort()
        await expect(gateway.execute({ scope: admitted.scope, request, signal: controller.signal })).rejects.toThrow('CANCELLED_UNSENT')
        expect((await balance()).reserved).toBe(0n); expect(complete).not.toHaveBeenCalled()
        await gateway.execute({ scope: admitted.scope, request: { ...request, attempt: 1 } })
        expect(complete).toHaveBeenCalledTimes(1)
        expect(await ds.getRepository(HostingModelCallEntity).count()).toBe(2)
        expect((await balance()).reserved).toBe(0n)
        expect((await currentGrant()).consumed).toBeGreaterThan(1n)
        expect(hostingCatalog.aiMicroUsdPerCredit).toBe(250)
    })
})
