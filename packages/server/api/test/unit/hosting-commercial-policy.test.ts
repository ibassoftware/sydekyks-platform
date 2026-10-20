import { hostingCatalog } from '@activepieces/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStripePolicy, StripeCatalog } from '../../src/app/hosting/hosting-stripe-policy'

const catalog = () => ({ version: hostingCatalog.version, accountId: 'acct_synthetic', portalConfigurationId: 'bpc_synthetic', origin: 'http://localhost', plans: {
    starter: { priceId: 'price_starter', amountMinor: 9900, currency: 'usd' },
    team: { priceId: 'price_growth', amountMinor: 39900, currency: 'usd' },
    scale: { priceId: 'price_scale', amountMinor: 129900, currency: 'usd' },
} })
beforeEach(() => {
    vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_test_synthetic')
    vi.stubEnv('AP_HOSTED_STRIPE_WEBHOOK_SECRET', 'whsec_synthetic')
    vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify(catalog()))
})
afterEach(() => vi.unstubAllEnvs())

describe('approved local commercial catalogue', () => {
    it('defines client seats and shared Credits independently of supplier token counts', () => {
        expect(['starter', 'team', 'scale'].map(planId => {
            const limits = hostingCatalog.getPlan({ planId: planId as 'starter' | 'team' | 'scale' })
            return [limits.users, limits.projects, limits.executions]
        })).toEqual([[10, 10, 10000], [30, 30, 100000], [100, 100, 500000]])
        expect(hostingCatalog.getPlan({ planId: 'training' })).toMatchObject({ users: 10, projects: 10 })
        expect(hostingCatalog.aiMicroUsdPerCredit).toBe(250)
        expect(hostingCatalog.partnerHostingMonths).toBe(12)
        expect(hostingCatalog.partnerPackages.core).toMatchObject({ amountMinor: 100000, coachingHours: 2, assessmentAttempts: 2 })
        expect(hostingCatalog.partnerPackages.launch).toMatchObject({ amountMinor: 120000, coachingHours: 4, proposalReviews: 1, assessmentAttempts: 2 })
        expect(hostingCatalog.paidPlans.scale.salesAssisted).toBe(true)
    })
    it('accepts the exact three-plan USD catalogue and preserves compatible old entitlement versions', () => {
        expect(readStripePolicy().catalog).toEqual(catalog())
        expect(hostingCatalog.supportedVersions).toContain('2026-10-15.v1')
    })
    it.each(['starter', 'team', 'scale'] as const)('rejects an unapproved %s amount or currency before purchasing', plan => {
        const changed = catalog(); changed.plans[plan].amountMinor += 1
        vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify(changed))
        expect(() => readStripePolicy()).toThrow('CATALOG_INVALID')
        changed.plans[plan].amountMinor -= 1; changed.plans[plan].currency = 'eur'
        vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify(changed))
        expect(() => readStripePolicy()).toThrow('CATALOG_INVALID')
    })
    it('rejects duplicate price IDs and incomplete old catalogues', () => {
        const changed = catalog(); changed.plans.scale.priceId = changed.plans.team.priceId
        vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify(changed))
        expect(() => readStripePolicy()).toThrow('CATALOG_INVALID')
        const { scale: _scale, ...oldPlans } = catalog().plans
        expect(StripeCatalog.safeParse({ ...catalog(), plans: oldPlans }).success).toBe(false)
    })
    it('rejects live credentials and untrusted return origins', () => {
        vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_live_synthetic')
        expect(() => readStripePolicy()).toThrow('TEST_CONFIGURATION_REQUIRED')
        vi.stubEnv('AP_HOSTED_STRIPE_SECRET_KEY', 'sk_test_synthetic')
        vi.stubEnv('AP_HOSTED_STRIPE_CATALOG_JSON', JSON.stringify({ ...catalog(), origin: 'http://untrusted.invalid' }))
        expect(() => readStripePolicy()).toThrow('RETURN_ORIGIN_DENIED')
    })
})
