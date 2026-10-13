import { describe, expect, it } from 'vitest'
import { isSupportedRelease } from '../../../../src/app/pieces/metadata/utils/piece-cache-utils'

describe('branded piece release compatibility', () => {
    it('uses the supported base release for Sydekyks without changing the worker protocol version', () => {
        expect(isSupportedRelease('0.93.0-sydekyks.1', { minimumSupportedRelease: '0.93.0' })).toBe(true)
        expect(isSupportedRelease('0.93.0-sydekyks.1', { maximumSupportedRelease: '0.92.0' })).toBe(false)
        expect(isSupportedRelease('0.93.0-sydekyks.1', { minimumSupportedRelease: '0.94.0' })).toBe(false)
    })
    it('retains standard prerelease and stable release boundaries', () => {
        expect(isSupportedRelease('0.93.0-beta.1', { minimumSupportedRelease: '0.93.0' })).toBe(false)
        expect(isSupportedRelease('0.93.0', { minimumSupportedRelease: '0.93.0' })).toBe(true)
    })
})
