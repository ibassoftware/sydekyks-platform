import { ServiceMode, serviceModePolicy } from '@activepieces/shared'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'

function getServiceMode(): ServiceMode {
    return serviceModePolicy.resolve({ value: system.get(AppSystemProp.SERVICE_MODE) })
}

function validate(): ServiceMode {
    const mode = getServiceMode()
    if (mode === 'self_hosted') return mode
    if (system.get(AppSystemProp.DB_TYPE) !== 'POSTGRES') throw new Error('Hosted service mode requires PostgreSQL')
    if (system.get(AppSystemProp.REDIS_TYPE) !== 'STANDALONE') throw new Error('Hosted service mode requires shared Redis')
    if (system.get(AppSystemProp.EXECUTION_MODE) !== 'SANDBOX_CODE_ONLY') throw new Error('Hosted service mode requires code sandboxing')
    const stripeKey = system.get(AppSystemProp.HOSTED_STRIPE_SECRET_KEY)
    if (!stripeKey || !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(stripeKey)) {
        throw new Error('Hosted Stripe configuration requires a test secret key; live billing is disabled')
    }
    const webhookSecret = system.get(AppSystemProp.HOSTED_STRIPE_WEBHOOK_SECRET)
    if (!webhookSecret || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
        throw new Error('Hosted Stripe configuration requires a webhook signing secret')
    }
    return mode
}

function assertRuntimeAvailable({ mode }: { mode: ServiceMode }): void {
    if (mode === 'hosted') throw new Error('HOSTED_IMPLEMENTATION_INCOMPLETE: hosted execution and signup are disabled until admission and billing are implemented')
}

export const hostingConfiguration = { getServiceMode, validate, assertRuntimeAvailable }
