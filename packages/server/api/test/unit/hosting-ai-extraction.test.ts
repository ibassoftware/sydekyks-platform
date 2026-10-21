import { describe, expect, it } from 'vitest'
import { hostedExtractionSchema } from '../../src/app/hosting/hosting-ai-extraction'

describe('hosted text extraction JSON boundary', () => {
    it('validates simple fields and preserves their exact names', () => {
        const extraction = hostedExtractionSchema({ mode: 'simple', fields: [{ name: 'Invoice Total', type: 'number', isRequired: true }, { name: 'paid', type: 'boolean', isRequired: false }] })
        expect(extraction.parse('{"Invoice Total":12.5,"paid":false}')).toEqual({ 'Invoice Total': 12.5, paid: false })
        expect(() => extraction.parse('{"Invoice Total":"12.5"}')).toThrow('HOSTING_AI_EXTRACTION_INVALID')
        expect(() => extraction.parse('{}')).toThrow('HOSTING_AI_EXTRACTION_INVALID')
        expect(() => extraction.parse('{"Invoice Total":1,"extra":true}')).toThrow('HOSTING_AI_EXTRACTION_INVALID')
    })
    it('validates bounded nested advanced schemas without coercing supplier values', () => {
        const extraction = hostedExtractionSchema({ mode: 'advanced', fields: { type: 'object', properties: { lines: { type: 'array', maxItems: 2, items: { type: 'object', properties: { amount: { type: 'number', minimum: 0 } }, required: ['amount'], additionalProperties: false } } }, required: ['lines'], additionalProperties: false } })
        expect(extraction.parse('{"lines":[{"amount":2}]}')).toEqual({ lines: [{ amount: 2 }] })
        expect(() => extraction.parse('{"lines":[{"amount":-1}]}')).toThrow('HOSTING_AI_EXTRACTION_INVALID')
        expect(() => extraction.parse('not JSON')).toThrow('HOSTING_AI_EXTRACTION_INVALID')
    })
    it('rejects unbounded schema features before a supplier call can be built', () => {
        for (const fields of [
            { type: 'object', properties: { value: { $ref: 'https://example.invalid/schema.json' } } },
            { type: 'object', patternProperties: { '(a+)+': { type: 'string' } } },
            { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+' } } },
        ]) expect(() => hostedExtractionSchema({ mode: 'advanced', fields })).toThrow('HOSTING_AI_SCHEMA_UNSUPPORTED')
        expect(() => hostedExtractionSchema({ mode: 'simple', fields: [{ name: 'a', type: 'string', isRequired: true }, { name: 'a', type: 'string', isRequired: true }] })).toThrow('HOSTING_AI_SCHEMA_INVALID')
    })
})
