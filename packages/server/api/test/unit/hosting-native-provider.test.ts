import { describe, expect, it, vi } from 'vitest'
import { NativeToolRequest, normalizeNativeToolResult, publicHttpsUrl, validatePublicFetchUrl } from '../../src/app/hosting/hosting-native-provider'
import { parseNativeToolPricing } from '../../src/app/hosting/hosting-pricing-source'

const nativePricingTable = '<table><tr><th>API</th><th>Unit</th><th>Price</th></tr><tr><td>Search</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr><tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr></table>'
const search = NativeToolRequest.parse({ callKey: `native:${'a'.repeat(64)}`, payer: { type: 'managed' }, model: 'sydekyks', kind: 'search', query: 'Synthetic public research' })
const fetch = NativeToolRequest.parse({ ...search, kind: 'fetch', query: undefined, url: 'https://example.com/article' })

describe('native search/fetch fixed supplier contract', () => {
    it('prices each successful request at exactly750microUSD, refusing ambiguous or changed billing units', () => {
        expect(parseNativeToolPricing(nativePricingTable)).toEqual({ version: 'deepseek-search-fetch-success-v1', search: 750, fetch: 750 })
        expect(parseNativeToolPricing('<table><tr><td>Token rates only</td></tr></table>')).toBeUndefined()
        expect(() => parseNativeToolPricing(nativePricingTable.repeat(2))).toThrow('AMBIGUOUS')
        expect(() => parseNativeToolPricing(nativePricingTable.replaceAll('successful requests', 'results'))).toThrow('INVALID')
        expect(() => parseNativeToolPricing(nativePricingTable.replace('$0.75', '$0.000001'))).toThrow('INVALID')
        expect(parseNativeToolPricing(nativePricingTable.replace('$0.75', '$1.25'))?.search).toBe(1250)
    })
    it.each(['http://example.com', 'https://user:secret@example.com', 'https://example.com:8443', 'https://localhost', 'https://a.internal', 'https://127.0.0.1', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1', 'https://172.20.0.1', 'https://192.168.1.2', 'https://100.64.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[2001:db8::1]', 'https://0x7f000001', 'https://2130706433'])('refuses unsafe fetch/citation URL %s', value => {
        expect(() => publicHttpsUrl(value)).toThrow('URL_DENIED')
    })
    it('refuses private DNS answers including mixed public/private and resolution failures', async () => {
        const resolver = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }])
        await expect(validatePublicFetchUrl('https://example.com', resolver)).rejects.toThrow('URL_DENIED')
        resolver.mockRejectedValue(new Error('private resolver detail'))
        await expect(validatePublicFetchUrl('https://example.com', resolver)).rejects.toThrow('URL_DENIED')
        resolver.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
        await expect(validatePublicFetchUrl('https://example.com/article#heading', resolver)).resolves.toBe('https://example.com/article')
    })
    it.each([400, 401, 402, 403, 404, 408, 429, 500, 504])('treats a complete HTTP%s response as known nonbillable', status => {
        expect(normalizeNativeToolResult(search, status, { error: { message: 'Sensitive supplier error' } })).toEqual({ result: { kind: 'search', results: [], excerpt: true, truncated: false }, billable: false })
    })
    it('distinguishes empty200, valid nonempty200 and unverified responses without guessing', () => {
        expect(normalizeNativeToolResult(search, 200, { results: [] }).billable).toBe(false)
        expect(normalizeNativeToolResult(fetch, 200, { title: '', content: '' }).billable).toBe(false)
        expect(normalizeNativeToolResult(fetch, 200, { content: 'Page content' }).billable).toBe(true)
        expect(() => normalizeNativeToolResult(search, 200, { error: 'unknown' })).toThrow('UNVERIFIED')
        expect(() => normalizeNativeToolResult(fetch, 200, { content: null })).toThrow('UNVERIFIED')
    })
    it('strips private and credential-bearing citations and bounds text while preserving actual provider billing', () => {
        const outcome = normalizeNativeToolResult(search, 200, { results: [{ title: 'Private', url: 'https://127.0.0.1' }, { title: 'Secret', url: 'https://user:secret@example.com' }, { title: '\u0000Safe title', url: 'https://example.com/a#fragment', snippet: 's'.repeat(20000), content: 'c'.repeat(20000) }] })
        expect(outcome.billable).toBe(true)
        expect(outcome.result).toEqual({ kind: 'search', results: [{ title: 'Safe title', url: 'https://example.com/a', snippet: 's'.repeat(360) }], excerpt: true, truncated: true })
        expect(normalizeNativeToolResult(search, 200, { results: [{ url: 'https://10.0.0.1' }] })).toEqual({ result: { kind: 'search', results: [], excerpt: true, truncated: true }, billable: true })
        expect(Buffer.byteLength(JSON.stringify(normalizeNativeToolResult(fetch, 200, { content: 'x'.repeat(100000) }).result), 'utf8')).toBeLessThanOrEqual(3000)
    })
    it('permits public 192.0/16 and 192.2/16 addresses while refusing their actual special-purpose /24 ranges', async () => {
        for (const address of ['192.0.66.108', '192.2.1.1']) {
            expect(publicHttpsUrl(`https://${address}/`).href).toBe(`https://${address}/`)
            const resolver = vi.fn().mockResolvedValue([{ address, family: 4 }])
            await expect(validatePublicFetchUrl('https://www.nasa.gov/', resolver)).resolves.toBe('https://www.nasa.gov/')
        }
        for (const address of ['192.0.0.1', '192.0.2.1', '192.168.1.1', '192.88.99.1']) expect(() => publicHttpsUrl(`https://${address}/`)).toThrow('URL_DENIED')
    })
    it('rejects oversized canonical or escape-heavy URLs before DNS or supplier dispatch', async () => {
        const resolver = vi.fn()
        const oversized = 'https://example.com/' + 'x'.repeat(2048)
        const expanded = 'https://example.com/?q=' + '界'.repeat(240)
        const escaped = 'https://example.com/?q=' + '\\'.repeat(1500)
        for (const url of [oversized, expanded, escaped]) {
            await expect(validatePublicFetchUrl(url, resolver)).rejects.toThrow('URL_DENIED')
        }
        expect(resolver).not.toHaveBeenCalled()
        const outcome = normalizeNativeToolResult(search, 200, { results: [{ title: 'Long', url: expanded, snippet: 'Content' }] })
        expect(outcome).toEqual({ result: { kind: 'search', results: [], excerpt: true, truncated: true }, billable: true })
    })
    it('returns at most three concise search excerpts without duplicate content and stays within 2500 exact JSON UTF-8 bytes', () => {
        const source = Array.from({ length: 5 }, (_, n) => ({ title: ('界🦸"\\\n').repeat(80), url: `https://example.com/${n}?q=` + 'x'.repeat(550), content: ('Useful fallback 🦸界"\\\n').repeat(100) }))
        const outcome = normalizeNativeToolResult(search, 200, { results: source })
        expect(outcome.billable).toBe(true)
        expect(outcome.result.kind).toBe('search')
        if (outcome.result.kind !== 'search') throw new Error('Expected search result')
        expect(outcome.result.results.length).toBeGreaterThan(0)
        expect(outcome.result.results.length).toBeLessThanOrEqual(3)
        expect(outcome.result.results.length).toBeLessThan(source.length)
        expect(outcome.result).toMatchObject({ excerpt: true, truncated: true })
        for (const item of outcome.result.results) {
            expect(item).not.toHaveProperty('content')
            expect(item.snippet).toContain('Useful fallback')
            expect(Buffer.byteLength(item.title, 'utf8')).toBeLessThanOrEqual(160)
            expect(Buffer.byteLength(item.snippet, 'utf8')).toBeLessThanOrEqual(360)
            expect(source.some(original => original.url === item.url)).toBe(true)
        }
        expect(Buffer.byteLength(JSON.stringify(outcome.result), 'utf8')).toBeLessThanOrEqual(2500)
    })
    it('retains one whole near-limit URL and a modest search excerpt within the full budget', () => {
        const url = 'https://example.com/?q=' + 'x'.repeat(2000)
        const outcome = normalizeNativeToolResult(search, 200, { results: [{ title: 'Title '.repeat(100), url, snippet: 'Useful excerpt '.repeat(100) }] })
        if (outcome.result.kind !== 'search') throw new Error('Expected search result')
        expect(outcome.result.results).toHaveLength(1)
        expect(outcome.result.results[0].url).toBe(url)
        expect(outcome.result.results[0].snippet.length).toBeGreaterThan(20)
        expect(outcome.result.truncated).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(outcome.result), 'utf8')).toBeLessThanOrEqual(2500)
    })
    it('fits fetch excerpts to 3000 exact serialized UTF-8 bytes including long URLs and escaped Unicode content', () => {
        const longUrl = 'https://example.com/?q=' + 'x'.repeat(2000)
        const request = NativeToolRequest.parse({ ...fetch, url: longUrl })
        const source = { title: ('"\\\n🦸界').repeat(200), content: ('"\\\n🦸界').repeat(1000) }
        const outcome = normalizeNativeToolResult(request, 200, source)
        expect(outcome.billable).toBe(true)
        expect(outcome.result.kind).toBe('fetch')
        if (outcome.result.kind !== 'fetch') throw new Error('Expected fetch result')
        expect(outcome.result.url).toBe(longUrl)
        expect(outcome.result).toMatchObject({ excerpt: true, truncated: true })
        expect(Buffer.byteLength(outcome.result.title, 'utf8')).toBeLessThanOrEqual(120)
        expect(Buffer.byteLength(outcome.result.content, 'utf8')).toBeLessThanOrEqual(1800)
        expect(Buffer.byteLength(JSON.stringify(outcome.result), 'utf8')).toBeLessThanOrEqual(3000)
        expect(outcome.result.content.endsWith('\ud83e')).toBe(false)
    })
    it('keeps successful supplier billing truthful even when sanitization or projection removes every excerpt', () => {
        const request = NativeToolRequest.parse({ ...fetch, url: 'https://example.com/' })
        const outcome = normalizeNativeToolResult(request, 200, { content: '\u0000' })
        expect(outcome).toEqual({ result: { kind: 'fetch', url: 'https://example.com/', title: '', content: '', excerpt: true, truncated: true }, billable: true })
        expect(normalizeNativeToolResult(search, 200, { results: [{ url: 'https://127.0.0.1' }] }).billable).toBe(true)
        expect(normalizeNativeToolResult(fetch, 200, { content: '   ' }).billable).toBe(false)
    })

})
