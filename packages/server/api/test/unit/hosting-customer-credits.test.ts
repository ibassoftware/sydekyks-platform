import { readFileSync } from 'node:fs'
import { apId } from '@activepieces/core-utils'
import { HostedBillingOverview, HostedCustomerBillingOverview, HostedOnboardingOffer, hostingCatalog, PrincipalType } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessTokenManager } from '../../src/app/authentication/lib/access-token-manager'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { authenticationMiddleware } from '../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { errorHandler } from '../../src/app/helper/error-handler'
import { createHostedBillingView } from '../../src/app/hosting/hosting-billing-view'
import { hostedChatOptions } from '../../src/app/hosting/hosting-chat-options'
import { hostingController } from '../../src/app/hosting/hosting-controller'
import { HostingGrantEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { saveManagedSettings } from '../../src/app/hosting/hosting-managed-settings'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPricing, hostedPricingView } from '../../src/app/hosting/hosting-pricing'
import { PRICING_CALENDAR } from '../../src/app/hosting/hosting-pricing-source'
import { createHostedStripe } from '../../src/app/hosting/hosting-stripe'
import { HostingStripeCommandEntity } from '../../src/app/hosting/hosting-stripe-entities'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { readHostedCredits } from '../../src/app/hosting/hosting-usage'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

// This route fixture needs no scheduled source refresh. All authorization,
// ledger, DTO, chat availability and billing services remain real.
vi.mock('../../src/app/hosting/hosting-pricing-controller', () => ({ hostingPricingController: async () => {} }))
const html = readFileSync(new URL('../fixtures/hosting-official-pricing.html', import.meta.url), 'utf8')
let ds: DataSource, app: FastifyInstance, previousConnection: unknown, actor: HostingActor, client: Awaited<ReturnType<typeof createClient>>
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-customer-credit-subject-at-least32characters' })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', verified: true, password: 'unused', firstName: 'Credit', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
async function createClient() {
    const identityId = await identity(), tenant = await onboarding().provision({ identityId, name: 'Customer credit fixture', operator: actor })
    return { ...tenant, identityId, actor: { identityId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion } }
}
async function headers() {
    const token = await accessTokenManager(app.log).generateToken({ id: client.userId, platform: { id: client.platformId }, type: PrincipalType.USER, tokenVersion: client.tokenVersion })
    return { authorization: `Bearer ${token}` }
}
async function options() {
    return tx.run({ dataSource: ds, fn: manager => hostedChatOptions({ manager, actor: client.actor, userId: client.userId, projectId: client.projectId! }) })
}
async function configureManaged() {
    await saveManagedSettings({ dataSource: ds, actor, input: { expectedRevision: 0, expectedGlobalRevision: 0, requestKey: 'customer-dto:managed', mode: 'set', model: 'deepseek-flash', credentialAction: 'replace', apiKey: 'synthetic-dto-test-key-never-an-upstream-key' } })
    const pricing = createHostedPricing({ dataSource: ds, fetchSource: async () => ({ html, date: new Date().toUTCString(), age: '0' }) })
    await pricing.observe()
    const view = await tx.run({ dataSource: ds, fn: async manager => hostedPricingView(manager, await tx.now(manager)) })
    await pricing.approve({ actor, input: { expectedRevision: view.revision, observationId: view.observationId!, termsHash: view.termsHash!, requestKey: 'customer-dto:approval', validUntil: PRICING_CALENDAR.until, calendarVersion: PRICING_CALENDAR.version } })
}
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    app = fastify()
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); app.setErrorHandler(errorHandler)
    app.addHook('preHandler', authenticationMiddleware); app.addHook('preHandler', authorizationMiddleware)
    await app.register(hostingController, { prefix: '/api/v1/hosting' }); await app.ready()
})
afterAll(async () => {
    if (app) await app.close()
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const operatorId = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), operatorId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', operatorId)
    actor = { identityId: operatorId, platformId: home.platformId, tokenVersion: home.tokenVersion }
    client = await createClient()
})

describe('customer execution-credit boundary', () => {
    it('defaults to manual billing and rejects checkout and portal before Stripe configuration or commands', async () => {
        vi.stubEnv('AP_HOSTED_BILLING_MODE', 'manual')
        vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', ''); vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', '')
        const auth = await headers(), before = await ds.getRepository(HostingStripeCommandEntity).count()
        const overview = await app.inject({ url: '/api/v1/hosting/billing/overview', headers: auth })
        expect(overview.statusCode).toBe(200)
        expect(overview.json()).toMatchObject({ billingMode: 'manual', environment: 'manual', portal: { enabled: false, reason: 'manual_billing' } })
        expect(overview.json().plans.every((plan: { checkout: { enabled: boolean, reason: string } }) => !plan.checkout.enabled && plan.checkout.reason === 'manual_billing')).toBe(true)
        for (const path of ['checkout', 'portal']) {
            const result = await app.inject({ method: 'POST', url: '/api/v1/hosting/billing/' + path, headers: auth, payload: path === 'checkout' ? { planId: 'starter' } : {} })
            expect(result.statusCode).toBe(403)
            expect(result.json()).toEqual({ code: 'HOSTING_MANUAL_BILLING_REQUIRED' })
        }
        await expect(createHostedStripe({ dataSource: ds })).rejects.toThrow('HOSTING_MANUAL_BILLING_REQUIRED')
        expect(await ds.getRepository(HostingStripeCommandEntity).count()).toBe(before)
    })
    it('strips supplier budgets from customer billing DTOs while preserving the full internal service/schema', async () => {
        const full = await createHostedBillingView({ dataSource: ds }).read(client.actor)
        expect(HostedBillingOverview.parse(full)).toEqual(full)
        expect(full.meters.managedAi.amount).toBe('1000000')
        expect(full.meters.previousPeriodHeldMicroUsd).toBe('0')
        expect(full.limits.aiCredits).toBe(0)
        expect(full.plans.map(plan => plan.limits.aiCredits)).toEqual([5000, 20000, 0])
        const customer = HostedCustomerBillingOverview.parse(full)
        expect(Object.keys(customer.meters)).toEqual(['execution'])
        expect(customer.limits).not.toHaveProperty('aiCredits')
        expect(customer.plans.every(plan => !('aiCredits' in plan.limits))).toBe(true)
        expect(customer.meters.execution).toEqual(full.meters.execution)
        expect(full.meters).toHaveProperty('managedAi')
        expect(full.limits.aiCredits).toBe(0)
    })
    it('returns only execution balances and sanitized billing data through real authenticated HTTP routes', async () => {
        const auth = await headers()
        expect((await app.inject('/api/v1/hosting/balance')).statusCode).toBeGreaterThanOrEqual(400)
        const balance = await app.inject({ url: '/api/v1/hosting/balance', headers: auth })
        expect(balance.statusCode, balance.body).toBe(200)
        expect(balance.json()).toHaveLength(1)
        expect(balance.json()[0]).toMatchObject({ meter: 'execution', unit: 'execution', amount: '1000', available: '1000', microcreditsPerUnit: null })
        expect(balance.body).not.toContain('managed_ai')
        const billing = await app.inject({ url: '/api/v1/hosting/billing/overview', headers: auth })
        expect(billing.statusCode, billing.body).toBe(200)
        expect(HostedCustomerBillingOverview.safeParse(billing.json()).success).toBe(true)
        expect(Object.keys(billing.json().meters)).toEqual(['execution'])
        expect(billing.body).not.toContain('managedAi')
        expect(billing.body).not.toContain('previousPeriodHeldMicroUsd')
        expect(billing.body).not.toContain('aiCredits')
    })
    it('removes aiCredits from the public onboarding offer without changing the internal trial catalog', async () => {
        const source = { catalogVersion: hostingCatalog.version, emailCodesAvailable: false, trialDays: hostingCatalog.trialDays, trial: hostingCatalog.getPlan({ planId: 'trial' }) }
        expect(HostedOnboardingOffer.parse(source).trial).not.toHaveProperty('aiCredits')
        expect(source.trial.aiCredits).toBe(1000)
        const offer = await app.inject('/api/v1/hosting/onboarding')
        expect(offer.statusCode, offer.body).toBe(200)
        expect(offer.json().trial).toMatchObject({ executions: 1000, byokEnabled: true })
        expect(offer.body).not.toContain('aiCredits')
    })
    it('exposes execution credits and Sydekyks availability while keeping positive internal managed budgets hidden', async () => {
        await configureManaged()
        const visible = await options()
        expect(visible.managedAvailable).toBe(true)
        expect(Object.keys(visible.credits)).toEqual(['execution'])
        expect(visible.model).toEqual({ id: 'sydekyks', label: 'Sydekyks' })
        expect(visible.credits.execution.available).toBe('1000')
        expect(JSON.stringify(visible)).not.toContain('deepseek')
        expect(JSON.stringify(visible)).not.toContain('synthetic-dto-test-key')
    })
    it.each(['managed_ai', 'execution'] as const)('uses only shared Credits for admission when historical %s is exhausted', async meter => {
        await configureManaged()
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: client.platformId, meter })
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { consumed: grant.amount })
        const visible = await options()
        expect(visible.managedAvailable).toBe(meter === 'managed_ai')
        expect(Object.keys(visible.credits)).toEqual(['execution'])
        expect(visible.credits.execution.available).toBe(meter === 'execution' ? '0' : '1000')
        const internal = await tx.run({ dataSource: ds, fn: async manager => {
            const account = await tx.account({ manager, platformId: client.platformId })
            return readHostedCredits(manager, account, await tx.now(manager))
        } })
        expect(BigInt(meter === 'managed_ai' ? internal.ai.available : internal.execution.available)).toBe(0n)
        expect(internal).toHaveProperty('ai')
    })
})
