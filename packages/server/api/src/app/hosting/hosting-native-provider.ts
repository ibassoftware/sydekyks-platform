import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { safeHttp } from '@activepieces/server-utils'
import { z } from 'zod'
import { HOSTED_AI_TIMEOUT_MS } from './hosting-ai-policy'
import { hostingFail } from './hosting-transactions'

export const NativeToolRequest = z.strictObject({
    callKey: z.string().regex(/^native:[a-f0-9]{64}$/), attempt: z.literal(0).default(0),
    payer: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('managed') }), z.strictObject({ type: z.literal('byok'), configId: z.string().length(21) })]),
    model: z.enum(['sydekyks', 'deepseek-flash']), kind: z.enum(['search', 'fetch']),
    stepName: z.string().min(1).max(256).optional(),
    query: z.string().trim().min(1).max(128).optional(), url: z.string().max(8192).optional(),
}).superRefine((input, ctx) => {
    if (input.kind === 'search' ? !input.query || input.url !== undefined : !input.url || input.query !== undefined) ctx.addIssue({ code: 'custom', message: 'Provide only the selected tool input.' })
})
export type NativeToolInput = z.infer<typeof NativeToolRequest>
export type NativeToolResult = ({ kind: 'search', results: Array<{ title: string, url: string, snippet: string }> } | { kind: 'fetch', url: string, title: string, content: string }) & { excerpt: true, truncated: boolean }
export type NativeToolProvider = { execute(input: { request: NativeToolInput, apiKey: string, signal?: AbortSignal }): Promise<{ status: number, data: unknown }> }

export const deepseekNativeToolProvider: NativeToolProvider = {
    async execute({ request, apiKey, signal }) {
        return safeHttp.axios.request<unknown>({ method: 'POST', url: `https://api.deepseek.com/v1/tools/${request.kind}`,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            data: request.kind === 'search' ? { query: request.query, count: 5, need_content: true } : { url: request.url },
            responseType: 'json', signal, timeout: HOSTED_AI_TIMEOUT_MS, maxRedirects: 0,
            maxContentLength: 2 * 1024 * 1024, maxBodyLength: 16384, validateStatus: () => true,
        })
    },
}

export function publicHttpsUrl(value: string): URL {
    let url: URL
    try {
        url = new URL(value)
    }
    catch {
        hostingFail('HOSTING_NATIVE_URL_DENIED')
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hostname.includes('.') && !isIP(hostname) || hostname.endsWith('.') || /(^|\.)(localhost|local|internal|invalid|test|lan|home|onion)$/.test(hostname) || isIP(hostname) && !publicAddress(hostname)) hostingFail('HOSTING_NATIVE_URL_DENIED')
    url.hash = ''
    // Bound the full canonical wire URL, including percent expansion. An
    // escape-heavy query also must fit the 2,200-byte JSON-string bound, leaving
    // room for useful excerpts within the complete 2,500/3,000-byte results.
    if (Buffer.byteLength(url.href, 'utf8') > 2048 || jsonBytes(url.href) > 2200) hostingFail('HOSTING_NATIVE_URL_DENIED')
    return url
}

export async function validatePublicFetchUrl(value: string, resolve = lookup): Promise<string> {
    const url = publicHttpsUrl(value), hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (!isIP(hostname)) {
        let addresses
        try {
            addresses = await resolve(hostname, { all: true })
        }
        catch {
            hostingFail('HOSTING_NATIVE_URL_DENIED')
        }
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) hostingFail('HOSTING_NATIVE_URL_DENIED')
    }
    return url.href
}

function publicAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number)
        return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 || a >= 224)
    }
    return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address)
}

const SEARCH_RESULT_BYTES = 2500
const FETCH_RESULT_BYTES = 3000

// Returned content is a bounded excerpt, not a claim to have read a whole page.
// Supplier billing is derived from the original complete HTTP response, never
// from whether its safe, projected excerpt survives the display budget.
export function normalizeNativeToolResult(input: NativeToolInput, status: number, data: unknown): { result: NativeToolResult, billable: boolean } {
    const empty: NativeToolResult = input.kind === 'search' ? { kind: 'search', results: [], excerpt: true, truncated: false } : { kind: 'fetch', url: publicHttpsUrl(input.url!).href, title: '', content: '', excerpt: true, truncated: false }
    // A complete provider error response is definitely non-billable under the
    // reviewed successful-request tariff. Transport ambiguity never reaches here.
    if (status !== 200) return { result: empty, billable: false }
    const row = data && typeof data === 'object' ? data as Record<string, unknown> : null
    if (!row) hostingFail('HOSTING_NATIVE_USAGE_UNVERIFIED')
    if (input.kind === 'fetch') {
        if (typeof row.content !== 'string') hostingFail('HOSTING_NATIVE_USAGE_UNVERIFIED')
        const title = cleanText(row.title, 120), content = cleanText(row.content, 1800)
        const result: Extract<NativeToolResult, { kind: 'fetch' }> = { kind: 'fetch', url: publicHttpsUrl(input.url!).href, title, content, excerpt: true, truncated: title !== textOf(row.title) || content !== row.content }
        if (jsonBytes(result) > FETCH_RESULT_BYTES) {
            result.truncated = true
            result.content = fitJsonText(result.content, candidate => jsonBytes({ ...result, content: candidate }) <= FETCH_RESULT_BYTES)
            // Escaped title characters can take more JSON bytes than UTF-8 bytes.
            if (jsonBytes(result) > FETCH_RESULT_BYTES) result.title = fitJsonText(result.title, candidate => jsonBytes({ ...result, title: candidate }) <= FETCH_RESULT_BYTES)
        }
        return { result, billable: row.content.trim().length > 0 }
    }
    if (!Array.isArray(row.results) || row.results.length > 50) hostingFail('HOSTING_NATIVE_USAGE_UNVERIFIED')
    const result: Extract<NativeToolResult, { kind: 'search' }> = { kind: 'search', results: [], excerpt: true, truncated: false }
    for (const value of row.results) {
        if (result.results.length >= 3) break
        if (!value || typeof value !== 'object') continue
        const item = value as Record<string, unknown>
        if (typeof item.url !== 'string') continue
        try {
            const url = publicHttpsUrl(item.url).href
            const originalSnippet = [item.snippet, item.summary, item.content].find(text => typeof text === 'string' && cleanText(text, 360).trim().length > 0)
            const title = cleanText(item.title, 160), snippet = cleanText(originalSnippet, 360)
            result.results.push({ title, url, snippet })
            if (title !== textOf(item.title) || snippet !== textOf(originalSnippet) || typeof item.content === 'string' && item.content !== snippet) result.truncated = true
        }
        catch { /* Omit unsafe or oversized citations without changing billing. */ }
    }
    if (result.results.length !== row.results.length) result.truncated = true
    // Keep canonical URLs whole. Remove tail results until the exact serialized
    // UTF-8 budget fits; no token/cost estimator or Credit limit is relaxed.
    while (jsonBytes(result) > SEARCH_RESULT_BYTES && result.results.length > 1) {
        result.results.pop()
        result.truncated = true
    }
    if (jsonBytes(result) > SEARCH_RESULT_BYTES && result.results.length === 1) {
        result.truncated = true
        const first = result.results[0]
        // Retain one usable source even when its complete URL is near the
        // guard. Reserve room for a modest snippet before filling its title.
        first.title = fitJsonText(first.title, title => jsonBytes({ ...result, results: [{ ...first, title, snippet: '' }] }) <= SEARCH_RESULT_BYTES - 128)
        first.snippet = fitJsonText(first.snippet, snippet => jsonBytes({ ...result, results: [{ ...first, snippet }] }) <= SEARCH_RESULT_BYTES)
    }
    return { result, billable: row.results.length > 0 }
}

function textOf(value: unknown): string {
    return typeof value === 'string' ? value : ''
}
function cleanText(value: unknown, maxBytes: number): string {
    const text = textOf(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    let size = 0, result = ''
    for (const point of text) {
        size += Buffer.byteLength(point, 'utf8')
        if (size > maxBytes) break
        result += point
    }
    return result
}
function jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
function fitJsonText(text: string, fits: (candidate: string) => boolean): string {
    const points = Array.from(text)
    let low = 0, high = points.length
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (fits(points.slice(0, middle).join(''))) low = middle
        else high = middle - 1
    }
    return points.slice(0, low).join('')
}
