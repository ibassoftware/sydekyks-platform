import { describe, expect, it } from 'vitest'
import { conversationTitle } from '../../src/app/syd/copilot/conversation-title'
describe('local conversation titles', () => {
    it('uses a readable first-message label without a model call', () => {
        expect(conversationTitle('  Add 25\n and 40 using Addition  ')).toBe('Add 25 and 40 using Addition')
        expect(conversationTitle('\u0000\n ')).toBeNull()
    })
    it('bounds Unicode labels without splitting a character', () => {
        expect(Array.from(conversationTitle('🦸'.repeat(100))!)).toHaveLength(72)
        expect(conversationTitle('x'.repeat(72))).toBe('x'.repeat(72))
        expect(conversationTitle('x'.repeat(73))).toBe('x'.repeat(71) + '…')
    })
})
