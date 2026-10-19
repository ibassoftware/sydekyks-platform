import { ServiceMode, serviceModePolicy } from '@activepieces/shared'
import { system } from '../helper/system/system'
import { hostedStorageLimits } from './hosting-storage'
import { AppSystemProp } from '../helper/system/system-props'

function getServiceMode(): ServiceMode {
    return serviceModePolicy.resolve({ value: system.get(AppSystemProp.SERVICE_MODE) })
}

function getBillingMode(): 'manual' | 'stripe_test' {
    const value = system.get(AppSystemProp.HOSTED_BILLING_MODE) ?? 'manual'
    if (value !== 'manual' && value !== 'stripe_test') throw new Error('AP_HOSTED_BILLING_MODE must be manual or stripe_test')
    return value
}
function assertStripeBilling(): void {
    if (getBillingMode() !== 'stripe_test') throw new Error('HOSTING_MANUAL_BILLING_REQUIRED')
}

function validate(): ServiceMode {
    const mode = getServiceMode()
    if (mode === 'self_hosted') return mode
    if (system.get(AppSystemProp.DB_TYPE) !== 'POSTGRES') throw new Error('Hosted service mode requires PostgreSQL')
    if (system.get(AppSystemProp.REDIS_TYPE) !== 'STANDALONE') throw new Error('Hosted service mode requires shared Redis')
    if (system.get(AppSystemProp.EXECUTION_MODE) !== 'SANDBOX_CODE_ONLY') throw new Error('Hosted service mode requires code sandboxing')
    if (system.get(AppSystemProp.FILE_STORAGE_LOCATION) !== 'DB' || system.getBoolean(AppSystemProp.S3_USE_SIGNED_URLS)) throw new Error('Hosted pilot requires bounded database file storage and unsigned uploads')
    hostedStorageLimits()
    if (getBillingMode() === 'stripe_test') {
        const stripeKey = system.get(AppSystemProp.HOSTED_STRIPE_SECRET_KEY)
        if (!stripeKey || !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(stripeKey)) {
            throw new Error('Hosted Stripe configuration requires a test secret key; live billing is disabled')
        }
        const webhookSecret = system.get(AppSystemProp.HOSTED_STRIPE_WEBHOOK_SECRET)
        if (!webhookSecret || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
            throw new Error('Hosted Stripe configuration requires a webhook signing secret')
        }
    }
    if (!system.get(AppSystemProp.HOSTED_OPERATOR_IDENTITY_IDS)?.trim()) throw new Error('Hosted pilot requires an explicit operator identity allowlist')
    if (system.get(AppSystemProp.SANDBOX_PROPAGATED_ENV_VARS)?.trim()) throw new Error('Hosted pilot prohibits propagating server environment variables into code sandboxes')
    return mode
}

function assertRuntimeAvailable({ mode }: { mode: ServiceMode }): void {
    // This release supports the deliberately bounded partner pilot profile.
    // Queue admission and RPC guards continue to reject unsupported job paths.
    if (mode === 'hosted') validate()
}

export const hostingConfiguration = { getServiceMode, getBillingMode, assertStripeBilling, validate, assertRuntimeAvailable }
