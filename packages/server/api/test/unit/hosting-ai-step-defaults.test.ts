import { PieceMetadataModel, PropertyType } from '@activepieces/pieces-framework'
import { describe, expect, it } from 'vitest'
import { hostedAiStepDefaults } from '../../src/app/hosting/hosting-ai-step-defaults'

function piece(): PieceMetadataModel {
    const text = { name: 'askAi', props: { provider: { type: PropertyType.DROPDOWN, required: true, displayName: 'Provider' }, model: { type: PropertyType.DROPDOWN, required: true, displayName: 'Model' }, prompt: { type: PropertyType.LONG_TEXT, displayName: 'Prompt', required: true } } }
    return { name: '@activepieces/piece-ai', actions: { askAi: text, summarizeText: { ...text, name: 'summarizeText' }, classifyText: { ...text, name: 'classifyText' }, extractStructuredData: { ...text, name: 'extractStructuredData' }, generateImage: { ...text, name: 'generateImage' } } } as unknown as PieceMetadataModel
}

describe('hosted AI step metadata defaults', () => {
    it('seeds supported text steps with the opaque Sydekyks connection and model', () => {
        const original = piece(), before = JSON.stringify(original)
        const offered = hostedAiStepDefaults(original, true)
        for (const name of ['askAi', 'summarizeText', 'classifyText', 'extractStructuredData']) {
            expect(offered.actions[name].props.provider.defaultValue).toEqual({ provider: 'activepieces' })
            expect(offered.actions[name].props.model.defaultValue).toBe('sydekyks')
            expect(offered.actions[name].props.prompt).toBe(original.actions[name].props.prompt)
        }
        expect(offered.actions.generateImage).toBe(original.actions.generateImage)
        expect(JSON.stringify(original)).toBe(before)
    })
    it('does not change self-hosted catalogue data or other Gadgets', () => {
        const original = piece()
        expect(hostedAiStepDefaults(original, false)).toBe(original)
        const other = { ...original, name: '@activepieces/piece-other' }
        expect(hostedAiStepDefaults(other, true)).toBe(other)
    })
    it('leaves unfamiliar provider schemas unchanged instead of injecting an incompatible default', () => {
        const original = piece()
        original.actions.askAi.props.provider = { type: PropertyType.LONG_TEXT, required: true, displayName: 'Provider', defaultValue: 'existing-provider' }
        expect(hostedAiStepDefaults(original, true).actions.askAi).toBe(original.actions.askAi)
        expect(original.actions.askAi.props.provider.defaultValue).toBe('existing-provider')
    })
})
