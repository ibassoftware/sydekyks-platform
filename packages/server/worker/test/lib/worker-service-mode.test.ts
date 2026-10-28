import { apVersionUtil } from '@activepieces/server-utils'
import { HOSTED_ACCOUNTING_PROTOCOL, HOSTED_RUNTIME_CAPABILITIES, HOSTED_RUNTIME_PROFILE } from '@activepieces/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerServiceMode } from '../../src/lib/config/worker-service-mode'

afterEach(() => vi.unstubAllEnvs())
const metadata = { accountingProtocol: HOSTED_ACCOUNTING_PROTOCOL, runtimeProfile: HOSTED_RUNTIME_PROFILE, capabilities: [...HOSTED_RUNTIME_CAPABILITIES], version: apVersionUtil.getCurrentRelease(), EXECUTION_MODE: 'SANDBOX_CODE_ONLY' }
function hosted() {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    vi.stubEnv('AP_WORKER_CONCURRENCY', '2')
    vi.stubEnv('AP_EXECUTION_MODE', 'SANDBOX_CODE_ONLY')
    vi.stubEnv('AP_WORKER_GROUP_ID', undefined)
    vi.stubEnv('AP_PROJECT_WORKER', 'false')
}
describe('worker service mode', () => {
    it('retains free selfhosting without server metadata and advertises implemented profile', () => {
        vi.stubEnv('AP_SERVICE_MODE', undefined)
        expect(workerServiceMode.getProps()).toMatchObject({ serviceMode: 'self_hosted', ...metadata })
        expect(() => workerServiceMode.assertSettings({ response: {} })).not.toThrow()
    })
    it('never permits API metadata to opt a selfhosted worker into hosting', () => {
        vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
        expect(() => workerServiceMode.assertSettings({ response: { SERVICE_MODE: 'hosted', HOSTING_ACCOUNTING_PROTOCOL: 1 } })).toThrow('does not match')
    })
    it('admits exact hosted profile and rejects old protocol, release and isolation', () => {
        hosted()
        const response = { SERVICE_MODE: 'hosted', HOSTING_ACCOUNTING_PROTOCOL: 1, HOSTING_RUNTIME_PROFILE: HOSTED_RUNTIME_PROFILE, HOSTING_RUNTIME_CAPABILITIES: [...HOSTED_RUNTIME_CAPABILITIES], APP_VERSION: metadata.version, EXECUTION_MODE: 'SANDBOX_CODE_ONLY' }
        expect(() => workerServiceMode.assertRuntimeAvailable()).not.toThrow()
        expect(workerServiceMode.getProps()).toEqual({ serviceMode: 'hosted', ...metadata })
        expect(() => workerServiceMode.assertSettings({ response })).not.toThrow()
        for (const patch of [{ HOSTING_ACCOUNTING_PROTOCOL: 0 }, { HOSTING_RUNTIME_PROFILE: 'obsolete' }, { HOSTING_RUNTIME_CAPABILITIES: [] }, { APP_VERSION: 'obsolete' }, { EXECUTION_MODE: 'UNSANDBOXED' }]) {
            expect(() => workerServiceMode.assertSettings({ response: { ...response, ...patch } })).toThrow()
        }
    })
    it.each(['0', '21', '2.5', '', 'invalid'])('rejects unbounded hosted concurrency %s', value => {
        hosted(); vi.stubEnv('AP_WORKER_CONCURRENCY', value)
        expect(() => workerServiceMode.assertRuntimeAvailable()).toThrow('concurrency')
    })
    it('rejects dedicated or unsandboxed hosted workers', () => {
        hosted(); vi.stubEnv('AP_WORKER_GROUP_ID', 'dedicated')
        expect(() => workerServiceMode.assertRuntimeAvailable()).toThrow('shared workers')
        vi.stubEnv('AP_WORKER_GROUP_ID', undefined); vi.stubEnv('AP_EXECUTION_MODE', 'UNSANDBOXED')
        expect(() => workerServiceMode.assertRuntimeAvailable()).toThrow('SANDBOX_CODE_ONLY')
    })
    it('rejects malformed local mode', () => {
        vi.stubEnv('AP_SERVICE_MODE', 'invalid')
        expect(() => workerServiceMode.getProps()).toThrow('AP_SERVICE_MODE')
    })
})
