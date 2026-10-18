import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { safeHttp } from '@activepieces/server-utils'
import { z } from 'zod'
import { hostingFail } from './hosting-transactions'

export const HOSTED_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const PRICING_FRESH_MS = 10 * 60_000
const DEADLINE_MS = 10_000
const MAX_BODY_BYTES = 512 * 1024
const REQUEST_HEADERS = Object.freeze({ Accept: 'text/html', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' })
const strongEtag = (value: string | null): value is string => value !== null && /^"[\x21\x23-\x7e\x80-\xff]{0,200}"$/.test(value)
const responseEvidence = z.strictObject({
    status: z.union([z.literal(200), z.literal(304)]), requestedAt: z.iso.datetime(), receivedAt: z.iso.datetime(),
    date: z.string().max(128), age: z.string().max(20).nullable(), etag: z.string().max(256).nullable(), vary: z.string().max(256).nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/), bodyBytes: z.number().int().min(0).max(MAX_BODY_BYTES),
})
export const PricingSourceValidation = z.strictObject({
    version: z.literal('http-validation-v1'), mode: z.enum(['fresh_200', 'revalidated_304', 'conditional_200']),
    url: z.literal(HOSTED_PRICING_URL), requests: z.array(responseEvidence).min(1).max(2),
}).superRefine((value, ctx) => {
    const [first, second] = value.requests
    if (first.status !== 200 || (value.mode === 'fresh_200' ? !!second : !second) ||
        (second && (Date.parse(second.requestedAt) < Date.parse(first.receivedAt) || second.status !== (value.mode === 'revalidated_304' ? 304 : 200))) ||
        (value.mode === 'revalidated_304' && (!strongEtag(first.etag) || second?.etag !== first.etag || second.bodyBytes !== 0 || second.contentHash !== digest('')))) ctx.addIssue({ code: 'custom', message: 'Invalid pricing validation chain' })
})
export type PricingSourceValidation = z.infer<typeof PricingSourceValidation>
export type PricingSource = { html: string, date: string | undefined, age: string | undefined, sourceValidation?: PricingSourceValidation | null }
export type PricingFetcher = (signal?: AbortSignal) => Promise<PricingSource>
type HttpResponse = { status: number, data: unknown, headers: Record<string, unknown> }
type HttpRequest = { method: 'GET', url: typeof HOSTED_PRICING_URL, headers: Record<string, string>, signal: AbortSignal, timeout: number, maxRedirects: number, maxContentLength: number, maxBodyLength: number, responseType: 'text', validateStatus: () => boolean }
export type PricingHttpTransport = (request: HttpRequest) => Promise<HttpResponse>
const transport: PricingHttpTransport = request => safeHttp.axios.request<string>(request)

// The injectable boundary is transport only. URL, headers, limits and validation
// are server policy; no browser/operator input can change them.
export function createOfficialPricingFetcher(request: PricingHttpTransport = transport): PricingFetcher {
    return async callerSignal => {
        if (callerSignal?.aborted) hostingFail('HOSTING_PRICING_SOURCE_ABORTED')
        const abort = new AbortController(), started = performance.now()
        let rejectAbort!: (reason: Error) => void
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject 
        })
        const cancel = () => {
            abort.abort(); rejectAbort(new Error('HOSTING_PRICING_SOURCE_ABORTED')) 
        }
        callerSignal?.addEventListener('abort', cancel, { once: true })
        const timer = setTimeout(cancel, DEADLINE_MS)
        timer.unref()
        async function get(etag?: string): Promise<{ html: string, evidence: z.infer<typeof responseEvidence> }> {
            const remaining = Math.floor(DEADLINE_MS - (performance.now() - started))
            if (abort.signal.aborted || remaining <= 0) hostingFail('HOSTING_PRICING_SOURCE_ABORTED')
            const requestedAt = new Date()
            const response = await Promise.race([request({ method: 'GET', url: HOSTED_PRICING_URL, headers: { ...REQUEST_HEADERS, ...(etag ? { 'If-None-Match': etag } : {}) }, signal: abort.signal, timeout: remaining, maxRedirects: 0, maxContentLength: MAX_BODY_BYTES, maxBodyLength: 0, responseType: 'text', validateStatus: () => true }), aborted])
            const receivedAt = new Date()
            if (abort.signal.aborted || performance.now() - started >= DEADLINE_MS) hostingFail('HOSTING_PRICING_SOURCE_ABORTED')
            if (![200, 304].includes(response.status) || typeof response.data !== 'string' || Buffer.byteLength(response.data) > MAX_BODY_BYTES || (response.status === 200 && !/^text\/html(?:\s*;|$)/i.test(header(response, 'content-type') ?? ''))) hostingFail('HOSTING_PRICING_SOURCE_UNAVAILABLE')
            const evidence = responseEvidence.parse({ status: response.status, requestedAt: requestedAt.toISOString(), receivedAt: receivedAt.toISOString(), date: header(response, 'date'), age: header(response, 'age'), etag: header(response, 'etag'), vary: header(response, 'vary'), contentHash: digest(response.data), bodyBytes: Buffer.byteLength(response.data) })
            metadataAge(evidence, receivedAt)
            varyNames(evidence.vary)
            return { html: response.data, evidence }
        }
        try {
            const first = await get()
            if (first.evidence.status !== 200) hostingFail('HOSTING_PRICING_SOURCE_INVALID')
            if (metadataAge(first.evidence, new Date()) < PRICING_FRESH_MS) return result(first.html, 'fresh_200', [first.evidence])
            // A stale body is never made fresh by local timestamps. Only a real
            // conditional response may validate this exact stored representation.
            if (!strongEtag(first.evidence.etag)) hostingFail('HOSTING_PRICING_SOURCE_STALE')
            const second = await get(first.evidence.etag)
            if (second.evidence.status === 200) {
                if (metadataAge(second.evidence, new Date()) >= PRICING_FRESH_MS) hostingFail('HOSTING_PRICING_SOURCE_STALE')
                return result(second.html, 'conditional_200', [first.evidence, second.evidence])
            }
            if (second.html !== '' || second.evidence.etag !== first.evidence.etag || !strongEtag(second.evidence.etag) ||
                (second.evidence.vary !== null && varyNames(second.evidence.vary).join(',') !== varyNames(first.evidence.vary).join(',')) || metadataAge(second.evidence, new Date()) >= PRICING_FRESH_MS) hostingFail('HOSTING_PRICING_REVALIDATION_INVALID')
            return result(first.html, 'revalidated_304', [first.evidence, second.evidence])
        }
        finally {
            clearTimeout(timer)
            callerSignal?.removeEventListener('abort', cancel)
        }
    }
}
export const fetchOfficialPricing = createOfficialPricingFetcher()

// RFC9111 4.2.3: corrected age includes request delay and subsequent residence.
// A successful304 supplies its own Date/Age; absent new Age means zero, not the
// stale200 Age. The old body may be used only with the matching strong validator.
export function pricingSourceDate(source: PricingSource, now: Date): Date {
    if (source.sourceValidation) {
        const proof = PricingSourceValidation.parse(source.sourceValidation)
        if (Buffer.byteLength(JSON.stringify(proof)) > 4096) hostingFail('HOSTING_PRICING_SOURCE_INVALID')
        const first = proof.requests[0], last = proof.requests[proof.requests.length - 1]
        const body = proof.mode === 'revalidated_304' ? first : last
        if (body.contentHash !== digest(source.html) || body.bodyBytes !== Buffer.byteLength(source.html) || source.date !== last.date || (source.age ?? null) !== last.age) hostingFail('HOSTING_PRICING_SOURCE_INVALID')
        for (const item of proof.requests) {
            metadataAge(item, now); varyNames(item.vary) 
        }
        if (proof.mode === 'revalidated_304' && last.vary !== null && varyNames(last.vary).join(',') !== varyNames(first.vary).join(',')) hostingFail('HOSTING_PRICING_REVALIDATION_INVALID')
        const age = metadataAge(last, now)
        if (age >= PRICING_FRESH_MS) hostingFail('HOSTING_PRICING_SOURCE_STALE')
        return new Date(now.getTime() - age)
    }
    // Synthetic/internal fetchers without HTTP provenance retain strict Date/Age
    // validation. The production fetcher always supplies its bounded proof.
    const received = now.toISOString()
    const evidence = { date: source.date ?? '', age: source.age ?? null, requestedAt: received, receivedAt: received }
    const age = metadataAge(evidence, now)
    if (age >= PRICING_FRESH_MS) hostingFail('HOSTING_PRICING_SOURCE_STALE')
    return new Date(now.getTime() - age)
}
function result(html: string, mode: PricingSourceValidation['mode'], requests: PricingSourceValidation['requests']): PricingSource {
    const sourceValidation = PricingSourceValidation.parse({ version: 'http-validation-v1', mode, url: HOSTED_PRICING_URL, requests })
    const last = requests[requests.length - 1]
    return { html, date: last.date, age: last.age ?? undefined, sourceValidation }
}
function metadataAge(value: { date: string, age: string | null, requestedAt: string, receivedAt: string }, now: Date): number {
    const date = Date.parse(value.date), requested = Date.parse(value.requestedAt), received = Date.parse(value.receivedAt)
    const age = value.age === null ? 0 : /^\d{1,15}$/.test(value.age) ? Number(value.age) : Number.NaN
    if (!/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.date) || !Number.isFinite(date) || new Date(date).toUTCString() !== value.date || !Number.isSafeInteger(age) || !Number.isFinite(requested) || !Number.isFinite(received) || received < requested || received - requested > DEADLINE_MS || received > now.getTime() + 30_000 || date > received + 30_000 || date > now.getTime() + 30_000) hostingFail('HOSTING_PRICING_SOURCE_INVALID')
    return Math.max(0, received - date, age * 1000 + received - requested) + Math.max(0, now.getTime() - received)
}
function varyNames(value: string | null): string[] {
    if (value === null) return []
    const names = value.toLowerCase().split(',').map(item => item.trim())
    if (!names.length || names.some(name => !['accept', 'accept-encoding', 'cache-control', 'pragma'].includes(name)) || new Set(names).size !== names.length) hostingFail('HOSTING_PRICING_SOURCE_VARIANT_UNSUPPORTED')
    return names.sort()
}
function header(response: HttpResponse, name: string): string | null {
    const value = response.headers[name]
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || value.length > (name === 'date' ? 128 : 256) || /[\r\n\u0000]/.test(value)) hostingFail('HOSTING_PRICING_SOURCE_INVALID')
    return value
}
function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex') 
}
