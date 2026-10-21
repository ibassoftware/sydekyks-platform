import { apId } from '@activepieces/core-utils'
import { FlowActionType, FlowTrigger } from '@activepieces/shared'
import { describe, expect, it } from 'vitest'
import { hostedFlowPayer } from '../../src/app/hosting/hosting-flow-payer'

function ai(name: string, provider: unknown = { provider: 'activepieces' }, model = 'sydekyks'): Record<string, unknown> {
    return { name, type: FlowActionType.PIECE, settings: { pieceName: '@activepieces/piece-ai', actionName: 'askAi', input: { provider, model } } }
}
function version(nextAction?: Record<string, unknown>) {
    return { trigger: { name: 'trigger', type: 'PIECE_TRIGGER', nextAction } as unknown as FlowTrigger }
}
describe('server persisted workflow payer selection', () => {
    it('keeps no-AI and homogeneous managed flows managed', () => {
        expect(hostedFlowPayer(version())).toBe('managed')
        expect(hostedFlowPayer(version(ai('managed')))).toBe('managed')
        expect(hostedFlowPayer(version({ name: 'code', type: FlowActionType.CODE, nextAction: ai('managed') }))).toBe('managed')
    })
    it('uses byok only for exact static DeepSeek selections with an exact configured key', () => {
        expect(hostedFlowPayer(version(ai('byok', { provider: 'deepseek', configId: apId() }, 'deepseek-flash')))).toBe('byok')
        expect(() => hostedFlowPayer(version(ai('missing', 'deepseek', 'deepseek-flash')))).toThrow('EXACT_BYOK_KEY_REQUIRED')
        expect(() => hostedFlowPayer(version(ai('dynamic', { provider: '{{step.provider}}' })))).toThrow('PROVIDER_UNSUPPORTED')
        expect(() => hostedFlowPayer(version(ai('dynamic-key', { provider: 'deepseek', configId: '{{step.key}}' }, 'deepseek-flash')))).toThrow('EXACT_BYOK_KEY_REQUIRED')
    })
    it('reserves managed credits for mixed potential payer paths including nested branches', () => {
        const first = ai('managed'); first.nextAction = { name: 'router', type: FlowActionType.ROUTER, settings: {}, children: [ai('byok', { provider: 'deepseek', configId: apId() }, 'deepseek-flash')] }
        expect(hostedFlowPayer(version(first))).toBe('managed')
    })
    it('matches single-step engine scope without inspecting unexecuted successors', () => {
        const code = { name: 'code', type: FlowActionType.CODE, nextAction: ai('unfinished', undefined, '') }
        expect(hostedFlowPayer(version(code), 'code')).toBe('managed')
        const first = ai('managed'); first.nextAction = ai('byok', { provider: 'deepseek', configId: apId() }, 'deepseek-flash')
        expect(hostedFlowPayer(version(first), 'byok')).toBe('byok')
        expect(() => hostedFlowPayer(version(first), 'missing')).toThrow('SCOPE_MISMATCH')
    })
    it('allows text extraction but refuses attachments before flow execution', () => {
        const extract = ai('extract'); (extract.settings as Record<string, unknown>).actionName = 'extractStructuredData'
        expect(hostedFlowPayer(version(extract))).toBe('managed')
        const input = (extract.settings as { input: Record<string, unknown> }).input
        input.files = [{ file: '{{trigger.file}}' }]
        expect(() => hostedFlowPayer(version(extract))).toThrow('HOSTING_AI_EXTRACTION_TEXT_ONLY')
    })
    it('keeps unsupported image generation fenced while managed router and Agent execution are supported', () => {
        const extract = ai('extract'); (extract.settings as Record<string, unknown>).actionName = 'generateImage'
        expect(() => hostedFlowPayer(version(extract))).toThrow('PATH_UNSUPPORTED')
        expect(hostedFlowPayer(version({ name: 'router', type: FlowActionType.AI_ROUTER, settings: {} }))).toBe('managed')
        const agent = ai('agent'); (agent.settings as Record<string, unknown>).actionName = 'run_agent'
        expect(hostedFlowPayer(version(agent))).toBe('managed')
    })
})
