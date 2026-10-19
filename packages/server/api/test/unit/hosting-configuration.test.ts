import { apVersionUtil } from '@activepieces/server-utils'
import { HOSTED_RUNTIME_CAPABILITIES, HOSTED_RUNTIME_PROFILE } from '@activepieces/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { values } = vi.hoisted(() => ({ values: new Map<string, string>() }))
vi.mock('../../src/app/helper/system/system', () => ({ system: { get: (key: string) => values.get(key) } }))

import { hostingConfiguration } from '../../src/app/hosting/hosting-configuration'
import { hostingWorkerGate } from '../../src/app/hosting/hosting-worker-gate'

describe('hosting configuration', () => {
    beforeEach(() => values.clear())
    afterEach(() => values.clear())

    function hostedDefaults() {
        values.set('SERVICE_MODE', 'hosted')
        values.set('DB_TYPE', 'POSTGRES')
        values.set('REDIS_TYPE', 'STANDALONE')
        values.set('EXECUTION_MODE', 'SANDBOX_CODE_ONLY')
        values.set('HOSTED_BILLING_MODE', 'stripe_test')
        values.set('HOSTED_STRIPE_SECRET_KEY', 'sk_test_disposable')
        values.set('HOSTED_STRIPE_WEBHOOK_SECRET', 'whsec_disposable')
        values.set('HOSTED_OPERATOR_IDENTITY_IDS', 'testoperatoridentity1')
    }

    it('requires no hosting configuration for existing self-hosted installations', () => {
        expect(hostingConfiguration.validate()).toBe('self_hosted')
        expect(() => hostingConfiguration.assertRuntimeAvailable({ mode: 'self_hosted' })).not.toThrow()
    })

    it.each(['', 'cloud', 'invalid'])('rejects invalid mode %s instead of disabling billing', (mode) => {
        values.set('SERVICE_MODE', mode)
        expect(() => hostingConfiguration.validate()).toThrow('AP_SERVICE_MODE')
    })

    it.each([['DB_TYPE', 'PGLITE', 'PostgreSQL'], ['REDIS_TYPE', 'MEMORY', 'shared Redis'], ['EXECUTION_MODE', 'UNSANDBOXED', 'sandboxing']])('rejects unsafe hosted %s', (key, value, reason) => {
        hostedDefaults()
        values.set(key, value)
        expect(() => hostingConfiguration.validate()).toThrow(reason)
    })

    it.each(['sk_live_doNotLogThis', 'rk_live_doNotLogThis', '', 'invalid'])('rejects non-test Stripe key without exposing it', (key) => {
        hostedDefaults()
        values.set('HOSTED_STRIPE_SECRET_KEY', key)
        expect(() => hostingConfiguration.validate()).toThrow('live billing is disabled')
        try {
            hostingConfiguration.validate()
        }
        catch (error) {
            if (key) expect(String(error)).not.toContain(key)
        }
    })

    it('defaults to manual billing without requiring Stripe secrets and rejects invalid selection', () => {
        hostedDefaults()
        values.delete('HOSTED_BILLING_MODE'); values.delete('HOSTED_STRIPE_SECRET_KEY'); values.delete('HOSTED_STRIPE_WEBHOOK_SECRET')
        expect(hostingConfiguration.getBillingMode()).toBe('manual')
        expect(hostingConfiguration.validate()).toBe('hosted')
        expect(() => hostingConfiguration.assertStripeBilling()).toThrow('HOSTING_MANUAL_BILLING_REQUIRED')
        values.set('HOSTED_BILLING_MODE', 'live')
        expect(() => hostingConfiguration.validate()).toThrow('AP_HOSTED_BILLING_MODE')
    })

    it('permits only validated bounded hosted configuration', () => {
        hostedDefaults()
        expect(hostingConfiguration.validate()).toBe('hosted')
        expect(() => hostingConfiguration.assertRuntimeAvailable({ mode: 'hosted' })).not.toThrow()
        const workerProps = { serviceMode: 'hosted', accountingProtocol: 1, runtimeProfile: HOSTED_RUNTIME_PROFILE, capabilities: [...HOSTED_RUNTIME_CAPABILITIES], version: apVersionUtil.getCurrentRelease(), EXECUTION_MODE: 'SANDBOX_CODE_ONLY' }
        expect(hostingWorkerGate.isCompatible({ workerProps })).toBe(true)
        expect(hostingWorkerGate.isCompatible({ workerProps: { ...workerProps, version: 'obsolete' } })).toBe(false)
        values.delete('HOSTED_OPERATOR_IDENTITY_IDS')
        expect(() => hostingConfiguration.validate()).toThrow('operator identity allowlist')
    })

    it('withholds all hosted work even from a worker claiming future protocol support', () => {
        hostedDefaults()
        expect(hostingWorkerGate.isCompatible({ workerProps: { serviceMode: 'hosted', accountingProtocol: 1 } })).toBe(false)
        expect(hostingWorkerGate.isCompatible({})).toBe(false)
    })

    it('accepts legacy self-hosted metadata and rejects hostile or mismatched declarations', () => {
        expect(hostingWorkerGate.isCompatible({})).toBe(true)
        expect(hostingWorkerGate.isCompatible({ workerProps: { version: '1.0.8' } })).toBe(true)
        expect(hostingWorkerGate.isCompatible({ workerProps: { serviceMode: 'hosted' } })).toBe(false)
        expect(hostingWorkerGate.isCompatible({ workerProps: { serviceMode: 'unknown' } })).toBe(false)
        expect(hostingWorkerGate.isCompatible({ workerProps: { accountingProtocol: -1 } })).toBe(false)
    })
})
