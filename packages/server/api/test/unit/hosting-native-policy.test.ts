import { apId } from '@activepieces/core-utils'
import { FlowActionType, WorkerJobType } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { describe, expect, it, vi } from 'vitest'
import { HostingDispatch } from '../../src/app/hosting/hosting-dispatch-entity'
import { assertNativeWebSearchAllowed, nativeFeaturesEnabled } from '../../src/app/hosting/hosting-native-policy'

function step(name: string, webSearch: unknown, provider: unknown = { provider: 'activepieces' }) {
    return { name, type: FlowActionType.PIECE, settings: { pieceName: '@activepieces/piece-ai', actionName: 'askAi', input: { webSearch, provider } } }
}
function fixture() {
    const enabled = step('enabled', true), disabled = { ...step('disabled', false), nextAction: enabled }
    const version = { trigger: { name: 'trigger', type: 'PIECE_TRIGGER', nextAction: disabled } }
    const manager = { getRepository: () => ({ findOneByOrFail: vi.fn(async () => version), findOneBy: vi.fn(async () => version) }) } as unknown as EntityManager
    const segment = { payload: { jobType: WorkerJobType.EXECUTE_FLOW, flowVersionId: apId(), flowId: apId() } } as HostingDispatch
    return { manager, segment, enabled, disabled }
}

describe('native feature authority from persisted steps', () => {
    it('accepts the saved checkbox and requires the actual enabled workflow step', async () => {
        const { manager, segment } = fixture()
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'managed' }, stepName: 'enabled' })).resolves.toBeUndefined()
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'managed' }, stepName: 'disabled' })).rejects.toThrow('FEATURE_DENIED')
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'managed' } })).rejects.toThrow('FEATURE_DENIED')
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'managed' }, stepName: 'missing' })).rejects.toThrow('FEATURE_DENIED')
    })
    it('rejects an object, dynamic expression or string masquerading as the persisted opt-in', async () => {
        for (const input of [{ enabled: true }, '{{trigger.search}}', 'true']) {
            const { manager, segment, enabled } = fixture()
            enabled.settings.input.webSearch = input
            await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'managed' }, stepName: 'enabled' })).rejects.toThrow('FEATURE_DENIED')
        }
    })
    it('cannot borrow a sibling step key or bypass single-step test scope', async () => {
        const { manager, segment, enabled } = fixture(), configId = apId()
        enabled.settings.input.provider = { provider: 'deepseek', configId }
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'byok', configId }, stepName: 'enabled' })).resolves.toBeUndefined()
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'byok', configId: apId() }, stepName: 'enabled' })).rejects.toThrow('PAYER_CONFLICT')
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'managed' }, stepName: 'enabled' })).rejects.toThrow('PAYER_CONFLICT')
        segment.payload = { ...segment.payload, stepNameToTest: 'disabled' } as HostingDispatch['payload']
        await expect(assertNativeWebSearchAllowed(manager, segment, { payer: { type: 'byok', configId }, stepName: 'enabled' })).rejects.toThrow('FEATURE_DENIED')
    })
    it('identifies native roots before the first model call, including file-only workflows', async () => {
        const { manager, segment, enabled } = fixture()
        expect(await nativeFeaturesEnabled(manager, segment)).toBe(true)
        enabled.settings.input.webSearch = false
        Object.assign(enabled.settings.input, { fileIds: [apId()] })
        expect(await nativeFeaturesEnabled(manager, segment)).toBe(true)
        Object.assign(enabled.settings.input, { fileIds: [] })
        expect(await nativeFeaturesEnabled(manager, segment)).toBe(false)
    })
})
