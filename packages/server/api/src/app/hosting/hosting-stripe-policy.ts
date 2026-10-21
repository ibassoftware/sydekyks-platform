import { createHash } from 'node:crypto'
import { hostingCatalog } from '@activepieces/shared'
import { z } from 'zod'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { hostingFail } from './hosting-transactions'

export const STRIPE_API_VERSION = '2025-05-28.basil'
const price = z.strictObject({ priceId: z.string().regex(/^price_[a-zA-Z0-9]+$/), amountMinor: z.number().int().positive().max(100_000_000), currency: z.string().regex(/^[a-z]{3}$/) })
export const StripeCatalog = z.strictObject({ version: z.literal(hostingCatalog.version), accountId: z.string().regex(/^acct_[a-zA-Z0-9]+$/), portalConfigurationId: z.string().regex(/^bpc_[a-zA-Z0-9]+$/), origin: z.url(), plans: z.strictObject({ starter: price, team: price, scale: price }), partnerPackages: z.strictObject({ core: price, guided: price }).optional(), partnerCourseId: z.string().length(21).optional() })
export type HostedStripeCatalog = z.infer<typeof StripeCatalog>
export function readStripePolicy() {
    const secret = system.get(AppSystemProp.HOSTED_STRIPE_SECRET_KEY) ?? ''
    const signingSecret = system.get(AppSystemProp.HOSTED_STRIPE_WEBHOOK_SECRET) ?? ''
    if (!/^(sk|rk)_test_[a-zA-Z0-9]+$/.test(secret) || !/^whsec_[a-zA-Z0-9]+$/.test(signingSecret)) hostingFail('HOSTING_STRIPE_TEST_CONFIGURATION_REQUIRED')
    let raw: unknown
    try {
        raw = JSON.parse(system.get(AppSystemProp.HOSTED_STRIPE_CATALOG_JSON) ?? '')
    }
    catch {
        hostingFail('HOSTING_STRIPE_CATALOG_REQUIRED')
    }
    const parsed = StripeCatalog.safeParse(raw)
    if (!parsed.success) hostingFail('HOSTING_STRIPE_CATALOG_REQUIRED')
    const catalog = parsed.data
    const origin = new URL(catalog.origin)
    if (origin.origin !== catalog.origin || origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) hostingFail('HOSTING_STRIPE_RETURN_ORIGIN_DENIED')
    const plans = Object.entries(catalog.plans)
    if (new Set(plans.map(([, value]) => value.priceId)).size !== plans.length || plans.some(([id, value]) => value.currency !== 'usd' || value.amountMinor !== hostingCatalog.paidPlans[id as keyof typeof catalog.plans].amountMinor)) hostingFail('HOSTING_STRIPE_CATALOG_INVALID')
    if (Boolean(catalog.partnerPackages) !== Boolean(catalog.partnerCourseId)) hostingFail('HOSTING_STRIPE_CATALOG_INVALID')
    if (catalog.partnerPackages) {
        const packages = Object.entries(catalog.partnerPackages)
        const allPriceIds = [...plans, ...packages].map(([, value]) => value.priceId)
        if (new Set(allPriceIds).size !== allPriceIds.length || packages.some(([id, value]) => value.currency !== 'usd' || value.amountMinor !== (id === 'core' ? 100_000 : 120_000))) hostingFail('HOSTING_STRIPE_CATALOG_INVALID')
    }
    return { secret, signingSecret, catalog, hash: stripeDigest(catalog) }
}
export function stripeDigest(value: unknown): string {
    return createHash('sha256').update(canonical(JSON.parse(JSON.stringify(value)))).digest('hex')
}
export function stripeId(value: string | { id?: string } | null | undefined): string | null {
    return typeof value === 'string' ? value : value?.id ?? null
}

function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
