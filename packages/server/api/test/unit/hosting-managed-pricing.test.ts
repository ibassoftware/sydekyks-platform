import { readFileSync } from 'node:fs'
import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { createHostedAiGateway } from '../../src/app/hosting/hosting-ai-gateway'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingGrantEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { managedCredential, managedSettingsView, saveManagedSettings } from '../../src/app/hosting/hosting-managed-settings'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { assertPreparedPricing, createHostedPricing, hostedPricingView, readApprovedPricing } from '../../src/app/hosting/hosting-pricing'
import { ManagedSecretEntity, PricingObservationEntity } from '../../src/app/hosting/hosting-pricing-entities'
import { parseOfficialPricing, PRICING_CALENDAR, pricingBand } from '../../src/app/hosting/hosting-pricing-source'
import { createHostedTraining } from '../../src/app/hosting/hosting-training'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../src/app/lms/lms-content'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../../src/app/lms/lms-entities'
import { bootstrapHostedOperator, migratedHostedPGlite, scopedAiActionPayload } from '../helpers/hosting-fixtures'

const html = readFileSync(new URL('../fixtures/hosting-official-pricing.html', import.meta.url), 'utf8')
const input = { expectedRevision: 0, expectedGlobalRevision: 0, requestKey: 'global:first', mode: 'set' as const, model: 'deepseek-flash' as const, credentialAction: 'replace' as const, apiKey: 'synthetic-global-not-a-real-provider-key' }
let ds: DataSource, actor: HostingActor, client: HostingActor, projectId: string
const run = <T>(fn: Parameters<typeof tx.run<T>>[0]['fn']) => tx.run({ dataSource: ds, fn })
const source = () => ({ html, date: new Date().toUTCString(), age: '0' })
const view = () => run(async manager => hostedPricingView(manager, await tx.now(manager)))
const quote = (model: 'deepseek-flash' | 'deepseek-v4-pro' = 'deepseek-flash') => run(async manager => readApprovedPricing(manager, await tx.now(manager), model))
async function approve() {
    const pricing = createHostedPricing({ dataSource: ds, fetchSource: async () => source() })
    await pricing.observe()
    const current = await view()
    await pricing.approve({ actor, input: { expectedRevision: current.revision, observationId: current.observationId!, termsHash: current.termsHash!, requestKey: apId(), validUntil: PRICING_CALENDAR.until, calendarVersion: PRICING_CALENDAR.version } })
    return pricing
}
beforeAll(async () => {
    ds = await migratedHostedPGlite()
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-operator-subject-at-least32characters' })
    async function identity() {
        const id = apId()
        await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Fixture', tokenVersion: 'initial' })
        return id
    }
    const id = await identity(), home = await bootstrapHostedOperator(ds, onboarding, id)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', id)
    actor = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }
    projectId = home.projectId!
    const clientId = await identity(), tenant = await onboarding.provision({ identityId: clientId, name: 'Client', operator: actor })
    client = { identityId: clientId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion }
})

describe('managed pricing and operator settings', () => {
    it('requires an allowlisted current operator, encrypts secrets and never uses legacy env fallback', async () => {
        vi.stubEnv('AP_HOSTED_DEEPSEEK_API_KEY', 'must-never-fallback')
        await expect(run(manager => managedCredential(manager, client.platformId))).rejects.toThrow('MANAGED_AI_UNAVAILABLE')
        await expect(saveManagedSettings({ dataSource: ds, actor: client, input })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(saveManagedSettings({ dataSource: ds, actor: { ...actor, tokenVersion: 'stale' }, input })).rejects.toThrow('OPERATOR_REQUIRED')
        await saveManagedSettings({ dataSource: ds, actor, input })
        await saveManagedSettings({ dataSource: ds, actor, input })
        expect(await ds.getRepository(ManagedSecretEntity).count()).toBe(1)
        const masked = await run(manager => managedSettingsView(manager, client.platformId))
        expect(masked.credential).toMatchObject({ configured: true, scope: 'global' })
        expect(JSON.stringify(masked)).not.toContain(input.apiKey)
        expect(JSON.stringify(await ds.getRepository(ManagedSecretEntity).find())).not.toContain(input.apiKey)
        await expect(saveManagedSettings({ dataSource: ds, actor, input: { ...input, apiKey: 'another-synthetic-provider-key' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    })
    it('pins client overrides, rejects stale revisions and global pause defeats every override', async () => {
        await saveManagedSettings({ dataSource: ds, actor, input })
        const global = await run(manager => managedCredential(manager, actor.platformId))
        await saveManagedSettings({ dataSource: ds, actor, input: { ...input, platformId: client.platformId, expectedGlobalRevision: 1, requestKey: 'client:override', model: 'deepseek-v4-pro', apiKey: 'synthetic-client-managed-override-key' } })
        const override = await run(manager => managedCredential(manager, client.platformId))
        expect(override.model).toBe('deepseek-v4-pro')
        expect((await run(manager => managedCredential(manager, actor.platformId))).fingerprint).toBe(global.fingerprint)
        await expect(saveManagedSettings({ dataSource: ds, actor, input: { ...input, requestKey: 'stale' } })).rejects.toThrow('REVISION_CONFLICT')
        await saveManagedSettings({ dataSource: ds, actor, input: { ...input, expectedRevision: 1, expectedGlobalRevision: 1, requestKey: 'pause', mode: 'disabled', credentialAction: 'keep', apiKey: undefined } })
        await expect(run(manager => managedCredential(manager, client.platformId))).rejects.toThrow('MANAGED_AI_UNAVAILABLE')
        const masked = await run(manager => managedSettingsView(manager, client.platformId))
        expect(masked.credential.scope).toBe('client'); expect(masked.credential.configured).toBe(true)
        await saveManagedSettings({ dataSource: ds, actor, input: { ...input, expectedRevision: 2, expectedGlobalRevision: 2, requestKey: 'enable', credentialAction: 'keep', apiKey: undefined } })
        expect((await run(manager => managedCredential(manager, client.platformId))).fingerprint).not.toBe(override.fingerprint)
        await saveManagedSettings({ dataSource: ds, actor, input: { platformId: client.platformId, expectedRevision: 1, expectedGlobalRevision: 3, requestKey: 'inherit', mode: 'inherit', model: 'inherit', credentialAction: 'inherit' } })
        expect((await run(manager => managedCredential(manager, client.platformId))).apiKey).toBe(input.apiKey)
    })
    it('requires approval, keeps equivalent observations valid and uses matching model prices', async () => {
        const pricing = createHostedPricing({ dataSource: ds, fetchSource: async () => source() })
        await pricing.observe()
        await expect(quote()).rejects.toThrow('PRICING_UNAVAILABLE')
        await approve()
        const flash = await quote(), pro = await quote('deepseek-v4-pro')
        expect(flash.ceiling.cacheMiss).toBe(300000); expect(pro.ceiling.output).toBe(3960000)
        expect(Date.parse(flash.validUntil) - Date.parse(flash.validFrom)).toBeLessThanOrEqual(600000)
        await pricing.observe()
        await run(async manager => assertPreparedPricing(manager, flash, await tx.now(manager)))
        expect((await view()).approval?.validUntil).toBe(PRICING_CALENDAR.until)
        await expect(run(manager => readApprovedPricing(manager, new Date('2027-01-01T00:00:00Z'), 'deepseek-flash'))).rejects.toThrow('PRICING_UNAVAILABLE')
    })
    it('persists failures/mismatches and refuses stale evidence and mutated history', async () => {
        await approve()
        await createHostedPricing({ dataSource: ds, fetchSource: async () => {
            throw new Error('offline')
        } }).observe()
        expect((await view()).status).toBe('error')
        await expect(quote()).rejects.toThrow('PRICING_UNAVAILABLE')
        await createHostedPricing({ dataSource: ds, fetchSource: async () => ({ ...source(), html: html.replace('$0.003', '$0.004').replace('$0.006', '$0.008') }) }).observe()
        expect((await view()).status).toBe('mismatch')
        await expect(quote()).rejects.toThrow('PRICING_UNAVAILABLE')
        await createHostedPricing({ dataSource: ds, fetchSource: async () => ({ ...source(), age: '601' }) }).observe()
        expect((await view()).status).toBe('error')
        const row = await ds.getRepository(PricingObservationEntity).findOneByOrFail({ state: 'verified' })
        await expect(ds.getRepository(PricingObservationEntity).update({ id: row.id }, { termsHash: 'x' })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it('cancels known-unsent calls on key rotation, pins running credentials and keeps BYOK independent', async () => {
        await saveManagedSettings({ dataSource: ds, actor, input })
        await approve()
        const enrollmentId = apId(), courseId = apId(), now = new Date()
        await ds.getRepository(LmsCourseEntity).insert({ id: courseId, slug: `synthetic-${courseId}`, ownerPlatformId: null, audience: 'partner', certificationMode: 'partner', revision: 1, status: 'published', content: foundingCourseDraft, reviewedBy: actor.identityId, reviewedAt: now })
        await ds.getRepository(LmsEnrollmentEntity).insert({ id: enrollmentId, courseId, identityId: actor.identityId, grantPlatformId: null, accessType: 'partner_training', package: 'core', paymentReference: 'synthetic-paid-receipt', workspacePlatformId: actor.platformId, startsAt: now, accessUntil: new Date(now.getTime() + 365 * 86400000), assessmentUntil: new Date(now.getTime() + 90 * 86400000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
        await createHostedTraining({ dataSource: ds }).activate({ actor, platformId: actor.platformId, identityId: actor.identityId, enrollmentId, receiptId: 'synthetic-paid-receipt', tier: 'core' })
        const ledger = createHostedLedger({ dataSource: ds })
        async function admitted(payer: 'managed' | 'byok', configId?: string) {
            const reservation = await ledger.reserveExecution({ actor, projectId, key: apId(), payer })
            const claim = await ledger.claimExecution({ actor, reservationId: reservation.id }), admissionId = apId()
            await ds.getRepository(HostingDispatchEntity).insert({ id: apId(), platformId: actor.platformId, projectId, identityId: actor.identityId, tokenVersion: actor.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 'x'.repeat(64), state: 'running', rootKey: apId(), reservationId: reservation.id, admissionId, dispatchId: claim.dispatchId, leaseUntil: new Date(Date.now() + 60000), payload: scopedAiActionPayload({ platformId: actor.platformId, projectId, payer, configId }) })
            return { scope: { admissionId, platformId: actor.platformId, projectId }, reservation, dispatchId: claim.dispatchId! }
        }
        const request = { callKey: 'settings:rotation', attempt: 0, payer: { type: 'managed' as const }, model: 'sydekyks', messages: [{ role: 'user' as const, content: 'Synthetic input' }], max_tokens: 1 }
        let rotateDuringSend = false
        const complete = vi.fn(async ({ request: sent, apiKey }: { request: { model: string }, apiKey: string }) => {
            if (rotateDuringSend) {
                expect(apiKey).toBe('synthetic-rotation-before-send-key')
                await saveManagedSettings({ dataSource: ds, actor, input: { ...input, expectedRevision: 2, expectedGlobalRevision: 2, requestKey: 'during-send', apiKey: 'synthetic-rotation-during-send-key' } })
            }
            return { status: 200, data: { id: 'private-upstream', model: sent.model, created: Math.floor(Date.now() / 1000), object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic response' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2 } } }
        })
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic-provider', endpoint: 'diagnostic://no-network', complete } })
        // The post-transaction hook races a real authorized rotation between the
        // committed prepare and claim; no production authorization is mocked.
        const transaction = ds.transaction.bind(ds)
        let rotateBeforeSend = true
        const spy = vi.spyOn(ds, 'transaction').mockImplementation(async (...args: Parameters<typeof ds.transaction>) => {
            const value = await Reflect.apply(transaction, ds, args)
            if (rotateBeforeSend && value?.state === 'prepared' && value?.requestHash) {
                rotateBeforeSend = false
                await saveManagedSettings({ dataSource: ds, actor, input: { ...input, expectedRevision: 1, expectedGlobalRevision: 1, requestKey: 'before-send', apiKey: 'synthetic-rotation-before-send-key' } })
            }
            return value
        })
        const unsent = await admitted('managed')
        try {
            await expect(gateway.execute({ scope: unsent.scope, request })).rejects.toThrow('CREDENTIAL_CHANGED')
        }
        finally {
            spy.mockRestore()
        }
        expect(complete).not.toHaveBeenCalled()
        expect((await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ admissionId: unsent.scope.admissionId })).state).toBe('cancelled')
        await ledger.finishExecution({ platformId: actor.platformId, reservationId: unsent.reservation.id, dispatchId: unsent.dispatchId })
        rotateDuringSend = true
        const running = await admitted('managed')
        const response = await gateway.execute({ scope: running.scope, request: { ...request, callKey: 'running' } })
        expect(response.model).toBe('sydekyks')
        expect((await ds.getRepository(HostingModelCallEntity).findOneByOrFail({ admissionId: running.scope.admissionId })).state).toBe('settled')
        expect(complete).toHaveBeenCalledTimes(1)
        await ledger.finishExecution({ platformId: actor.platformId, reservationId: running.reservation.id, dispatchId: running.dispatchId })
        rotateDuringSend = false
        await saveManagedSettings({ dataSource: ds, actor, input: { ...input, expectedRevision: 3, expectedGlobalRevision: 3, requestKey: 'pause-byok', mode: 'disabled', credentialAction: 'keep', apiKey: undefined } })
        await createHostedPricing({ dataSource: ds, fetchSource: async () => {
            throw new Error('offline')
        } }).observe()
        const configId = apId()
        await ds.getRepository(AIProviderEntity).insert({ id: configId, platformId: actor.platformId, provider: 'deepseek', displayName: 'Exact client key', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-client-byok-secret-key' }), config: {}, status: 'active', enabledForChat: false, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
        const grants = () => ds.getRepository(HostingGrantEntity).findBy({ platformId: actor.platformId, meter: 'managed_ai' })
        const balances = (values: Awaited<ReturnType<typeof grants>>) => values.map(value => [value.id, value.reserved, value.consumed])
        const before = balances(await grants()), byok = await admitted('byok', configId)
        await gateway.execute({ scope: byok.scope, request: { ...request, callKey: 'byok', model: 'deepseek-flash', payer: { type: 'byok', configId } } })
        expect(complete.mock.calls.at(-1)?.[0].apiKey).toBe('synthetic-client-byok-secret-key')
        expect(balances(await grants())).toEqual(before)
    })
    it('rejects ambiguous model/capability/rates/schedules and uses exact UTC weekday bands', () => {
        for (const changed of [html.replace('deepseek-v4-pro</td>', 'deepseek-flash</td>'), html.replace('$0.003', '$0.004'), html.replace('Monday through Friday', 'Saturday through Sunday'), html.replace(/1M(?=<\/td>)/g, '2M')]) {
            expect(() => parseOfficialPricing({ ...source(), html: changed }, new Date())).toThrow()
        }
        expect(pricingBand(new Date('2026-10-19T01:00:00Z'))).toBe('peak')
        expect(pricingBand(new Date('2026-10-19T04:00:00Z'))).toBe('offPeak')
        expect(pricingBand(new Date('2026-10-18T02:00:00Z'))).toBe('offPeak')
    })
})
