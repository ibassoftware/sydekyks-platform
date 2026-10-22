import { describe, expect, it } from 'vitest'
import { hostedBuilderMetadata } from '../../src/app/hosting/hosting-builder-metadata'

const decode = (result: ReturnType<typeof hostedBuilderMetadata>) => JSON.parse(result.content[0].text)
describe('hosted builder catalogue result budget', () => {
    it('returns one schema representation, preserving required fields, nested inputs, defaults and real enum values', () => {
        const result = hostedBuilderMetadata('ap_get_piece_props', {
            content: [{ type: 'text', text: 'duplicated '.repeat(5000) }],
            structuredContent: { piece: '@activepieces/piece-webhook', name: 'catch_webhook', description: 'Receive leads', requiresAuth: false,
                props: [{ name: 'authType', type: 'STATIC_DROPDOWN', required: true, defaultValue: 'none', options: [{ label: 'None', value: 'none' }] }, { name: 'rows', type: 'ARRAY', required: true, items: [{ name: 'Email', type: 'SHORT_TEXT', required: true }] }],
                requiredInputs: { provideNow: ['authType', 'rows'], needsResolution: [] }, outputFields: ['body.email'], outputFieldsSource: 'declared',
                outputSchema: { description: 'unused verbose output schema '.repeat(1000) }, aiMetadata: { description: 'unused expertise '.repeat(1000) }, exampleInput: { rows: 'unneeded duplicate' },
            },
        })
        expect(result).not.toHaveProperty('structuredContent')
        const schema = decode(result)
        expect(schema.props[0]).toMatchObject({ name: 'authType', required: true, defaultValue: 'none', options: [{ label: 'None', value: 'none' }] })
        expect(schema.props[1].items[0]).toMatchObject({ name: 'Email', required: true })
        expect(schema.outputFields).toEqual(['body.email'])
        expect(schema.requiredInputs.provideNow).toEqual(['authType', 'rows'])
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2000)
    })
    it('preserves research action/trigger identifiers while dropping duplicated rich expertise', () => {
        const result = hostedBuilderMetadata('ap_research_pieces', { content: [{ type: 'text', text: 'long duplicate' }], structuredContent: { pieces: [{ name: '@activepieces/piece-tables', actions: [{ name: 'tables-create-records', displayName: 'Create Record(s)', description: 'Write records', aiDescription: 'very long '.repeat(2000), requiresAuth: false }], triggers: [{ name: 'new-record', description: 'New record' }] }], missing: [], count: 1 } })
        const metadata = decode(result)
        expect(metadata.pieces[0].actions[0]).toMatchObject({ name: 'tables-create-records', description: 'Write records', requiresAuth: false })
        expect(metadata.pieces[0].triggers[0].name).toBe('new-record')
        expect(result).not.toHaveProperty('structuredContent')
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1000)
    })
    it('returns an explicit narrow-query error rather than silently dropping required props when metadata is irreducible', () => {
        const result = hostedBuilderMetadata('ap_get_piece_props', { content: [], structuredContent: { props: Array.from({ length: 500 }, (_, index) => ({ name: `required_${index}`, type: 'SHORT_TEXT', required: true })) } })
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('No schema was returned')
        expect(result.content[0].text).toContain('Do not assume missing fields are optional')
    })
    it('bounds the actual escaped result envelope for quote-heavy schema metadata', () => {
        const result = hostedBuilderMetadata('ap_get_piece_props', { content: [], structuredContent: { props: Array.from({ length: 12 }, (_, index) => ({ name: `field_${index}`, type: 'SHORT_TEXT', required: true, defaultValue: '\"'.repeat(240) })) } })
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(6144)
        expect(result.isError).toBe(true)
    })
    it('does not alter user/data tool results, original objects or error outcomes', () => {
        const result = { content: [{ type: 'text' as const, text: 'stored user content' }], structuredContent: { records: [{ Email: 'user data' }] } }
        expect(hostedBuilderMetadata('ap_find_records', result)).toBe(result)
        const failed = { ...result, isError: true }
        expect(hostedBuilderMetadata('ap_get_piece_props', failed)).toBe(failed)
        expect(result.structuredContent.records[0].Email).toBe('user data')
    })
    it('discloses omitted large defaults and partial option labels instead of inventing schema values', () => {
        const result = hostedBuilderMetadata('ap_get_piece_props', { content: [], structuredContent: { props: [{ name: 'choice', type: 'STATIC_DROPDOWN', required: true, defaultValue: 'x'.repeat(1000), options: Array.from({ length: 31 }, (_, index) => ({ label: `Choice ${index}`, value: `id-${index}` })) }] } })
        const prop = decode(result).props[0]
        expect(prop.defaultValueOmitted).toBe(true)
        expect(prop).not.toHaveProperty('defaultValue')
        expect(prop.optionsTruncated).toBe(true)
        expect(prop.options[0].value).toBe('id-0')
    })
})
