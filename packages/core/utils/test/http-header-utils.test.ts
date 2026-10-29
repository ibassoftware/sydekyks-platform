import { validateHeaderName } from 'node:http'
import { describe, expect, it } from 'vitest'
import { sanitizeHttpHeaderName, sanitizeHttpHeaders } from '../src/lib/http-header-utils'

describe('webhook response header safety', () => {
    it('makes every byte and Unicode sample safe for Node HTTP headers', () => {
        for (const character of [...Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)), '☃', 'é', '\u2028']) {
            const name = sanitizeHttpHeaderName(`X-${character}-Test`)
            expect(() => validateHeaderName(name)).not.toThrow()
        }
    })

    it('preserves legal headers and values while dropping empty names', () => {
        expect(sanitizeHttpHeaders({ 'Content-type ': 'application/json', 'X-Request-Id': 'original-value', '\r\n': 'ignored' })).toEqual({ 'Content-type': 'application/json', 'X-Request-Id': 'original-value' })
        expect(sanitizeHttpHeaders(undefined)).toEqual({})
    })
})
