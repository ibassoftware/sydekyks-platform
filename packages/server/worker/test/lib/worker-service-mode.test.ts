import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerServiceMode } from '../../src/lib/config/worker-service-mode'

afterEach(() => vi.unstubAllEnvs())

describe('worker service mode', () => {
    it('reports local free mode and unimplemented accounting without needing sandbox settings', () => {
        vi.stubEnv('AP_SERVICE_MODE', undefined)
        expect(workerServiceMode.getProps()).toEqual({ serviceMode: 'self_hosted', accountingProtocol: 0 })
        expect(() => workerServiceMode.assertSettings({ response: {} })).not.toThrow()
    })

    it('does not permit an API response to opt a self-hosted worker into hosting', () => {
        vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
        expect(() => workerServiceMode.assertSettings({ response: { SERVICE_MODE: 'hosted', HOSTING_ACCOUNTING_PROTOCOL: 1 } })).toThrow('does not match')
    })

    it('rejects hosted workers before connecting or fetching provider catalogs', () => {
        vi.stubEnv('AP_SERVICE_MODE', 'hosted')
        expect(() => workerServiceMode.assertRuntimeAvailable()).toThrow('HOSTED_IMPLEMENTATION_INCOMPLETE')
        expect(workerServiceMode.getProps()).toEqual({ serviceMode: 'hosted', accountingProtocol: 0 })
    })

    it('rejects malformed local mode rather than reporting empty worker metadata', () => {
        vi.stubEnv('AP_SERVICE_MODE', 'invalid')
        expect(() => workerServiceMode.getProps()).toThrow('AP_SERVICE_MODE')
    })
})
