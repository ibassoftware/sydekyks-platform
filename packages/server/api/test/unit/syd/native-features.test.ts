import { describe, expect, it } from 'vitest'
import { SendAgentMessageRequest } from '@activepieces/shared'
import { nativeFilesForTurn, nativeUserParts, nativeUserTurn } from '../../../src/app/syd/copilot/native-features'

const id = (n: number) => String(n).padStart(21, 'a')
describe('private attachment reference history', () => {
    it('accepts file-only sends, limits new attachments to four and rejects raw URLs as IDs', () => {
        expect(SendAgentMessageRequest.safeParse({ content: '', nativeFileIds: [id(1)] }).success).toBe(true)
        expect(SendAgentMessageRequest.safeParse({ content: '', nativeFileIds: [] }).success).toBe(false)
        expect(SendAgentMessageRequest.safeParse({ content: 'Read', nativeFileIds: Array.from({ length: 5 }, (_, i) => id(i)) }).success).toBe(false)
        expect(SendAgentMessageRequest.safeParse({ content: 'Read', nativeFileIds: ['https://example.com/file'] }).success).toBe(false)
    })
    it('persists references without raw text, bytes, file URLs or extracted source content', () => {
        const turn = nativeUserTurn('Summarize', [id(1)])
        expect(turn).toEqual({ role: 'user', content: 'Summarize', providerOptions: { sydekyks: { nativeFileIds: [id(1)] } } })
        expect(nativeUserParts('', [{ name: 'confidential.txt' }])[0].text).toBe('Attached: 1 private attachment')
        expect(nativeFilesForTurn([turn], [id(1), id(2)])).toEqual([id(1), id(2)])
    })
    it('bounds cumulative history and refuses corrupt persisted references', () => {
        const history = nativeUserTurn('Read', Array.from({ length: 20 }, (_, i) => id(i)))
        expect(() => nativeFilesForTurn([history], [id(21)])).toThrow('HOSTING_NATIVE_FILE_LIMIT')
        expect(() => nativeFilesForTurn([{ role: 'user', providerOptions: { sydekyks: { nativeFileIds: ['bad'] } } }])).toThrow('HOSTING_NATIVE_FILE_INVALID')
    })
})
