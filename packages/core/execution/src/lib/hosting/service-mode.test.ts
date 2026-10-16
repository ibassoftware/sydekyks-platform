import { describe, expect, it } from 'vitest'
import { serviceModePolicy } from './service-mode'

describe('service mode compatibility', () => {
    it('defaults only an absent setting to free self-hosting', () => {
        expect(serviceModePolicy.resolve({})).toBe('self_hosted')
        for (const value of ['', 'cloud', 'HOSTED', ' hosted', 'false']) {
            expect(() => serviceModePolicy.resolve({ value })).toThrow('AP_SERVICE_MODE')
        }
    })

    it('preserves old self-hosted workers without new metadata', () => {
        expect(serviceModePolicy.workerIsCompatible({ apiMode: 'self_hosted' })).toBe(true)
        expect(serviceModePolicy.workerIsCompatible({ apiMode: 'self_hosted', workerMode: 'self_hosted', accountingProtocol: 0 })).toBe(true)
    })

    it('rejects workers from a different mode', () => {
        expect(serviceModePolicy.workerIsCompatible({ apiMode: 'self_hosted', workerMode: 'hosted', accountingProtocol: 1 })).toBe(false)
        expect(serviceModePolicy.workerIsCompatible({ apiMode: 'hosted', workerMode: 'self_hosted', accountingProtocol: 1 })).toBe(false)
    })

    it.each([undefined, 0, 2, '1', -1])('rejects hosted worker accounting protocol %s', (accountingProtocol) => {
        expect(serviceModePolicy.workerIsCompatible({ apiMode: 'hosted', workerMode: 'hosted', accountingProtocol })).toBe(false)
    })

    it('requires an explicit hosted declaration and the exact accounting protocol', () => {
        expect(serviceModePolicy.workerIsCompatible({ apiMode: 'hosted', accountingProtocol: 1 })).toBe(false)
        expect(serviceModePolicy.workerIsCompatible({ apiMode: 'hosted', workerMode: 'hosted', accountingProtocol: 1 })).toBe(true)
    })

    it('never adopts the server mode in place of the local worker mode', () => {
        expect(() => serviceModePolicy.assertWorkerSettings({ localMode: 'self_hosted', serverMode: 'hosted', accountingProtocol: 1 })).toThrow('does not match')
        expect(() => serviceModePolicy.assertWorkerSettings({ localMode: 'hosted' })).toThrow('does not match')
        expect(() => serviceModePolicy.assertWorkerSettings({ localMode: 'self_hosted' })).not.toThrow()
    })
})
