import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_DEEPSEEK_PRO_MODEL } from './hosting-ai-policy'
import { PricingSource, pricingSourceDate, PricingSourceValidation } from './hosting-pricing-http'
export { createOfficialPricingFetcher, fetchOfficialPricing, HOSTED_PRICING_URL, PRICING_FRESH_MS, PricingFetcher, PricingHttpTransport, PricingSource, PricingSourceValidation } from './hosting-pricing-http'
import { hostingFail } from './hosting-transactions'

export { PRICING_REFRESH_MS } from './hosting-pricing-timing'
export const PRICING_CALENDAR = Object.freeze({
    version: 'cn-state-council-2026-q4-v1', schedule: 'Peak: Monday–Friday 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays. All other times are off-peak.', from: '2026-10-18T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', holidays: [] as string[],
    source: 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm',
    reference: 'State Council 2025-11-04 国办发明电〔2025〕7号; all 2026 holidays end by October 7',
})
const rate = z.number().int().nonnegative().max(1_000_000_000)
export const PricingRates = z.strictObject({ cacheHit: rate, cacheMiss: rate.positive(), output: rate.positive() })
const model = z.strictObject({ peak: PricingRates, offPeak: PricingRates, version: z.string().min(1).max(160) })
export const PricingTerms = z.strictObject({
    parserVersion: z.literal('deepseek-html-v1'), schedule: z.literal('weekdays-utc-01-04-06-10-except-cn-holidays'),
    models: z.strictObject({ [HOSTED_DEEPSEEK_MODEL]: model, [HOSTED_DEEPSEEK_PRO_MODEL]: model }),
    table: z.array(z.array(z.string().max(1000)).length(5)).min(10).max(40),
})
export type PricingTerms = z.infer<typeof PricingTerms>
export function parseOfficialPricing(source: PricingSource, now: Date): { terms: PricingTerms, termsHash: string, contentHash: string, sourceAt: Date, sourceValidation: PricingSourceValidation | null } {
    if (Buffer.byteLength(source.html) > 512 * 1024) hostingFail('HOSTING_PRICING_SOURCE_INVALID')
    const sourceAt = pricingSourceDate(source, now)
    const html = source.html.replace(/<!--[^]*?-->|<script\b[^]*?<\/script\s*>|<style\b[^]*?<\/style\s*>/gi, '')
    const text = clean(html)
    const schedule = 'Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other hours are off-peak, including weekends and Chinese public holidays in full.'
    if (text.split(schedule).length !== 2) hostingFail('HOSTING_PRICING_SCHEDULE_UNVERIFIED')
    const tables = [...html.matchAll(/<table\b[^>]*>([^]*?)<\/table\s*>/gi)].map(match => match[1]).filter(value => /MODEL/.test(clean(value)) && /deepseek-flash/.test(value))
    if (tables.length !== 1) hostingFail('HOSTING_PRICING_TABLE_AMBIGUOUS')
    const rows = [...tables[0].matchAll(/<tr\b[^>]*>([^]*?)<\/tr\s*>/gi)]
    if (rows.length < 10 || rows.length > 40) hostingFail('HOSTING_PRICING_TABLE_INVALID')
    const grid: string[][] = []
    for (const [r, row] of rows.entries()) {
        grid[r] ??= []
        let column = 0
        const cells = [...row[1].matchAll(/<(td|th)\b([^>]*)>([^]*?)<\/\1\s*>/gi)]
        for (const cell of cells) {
            while (grid[r][column] !== undefined) column++
            const span = (name: string) => {
                if (!new RegExp(`\\b${name}\\s*=`, 'i').test(cell[2])) return 1
                const found = cell[2].match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)["']?(?=\\s|$)`, 'i'))
                const n = found ? Number(found[1]) : 0
                if (n < 1 || n > 10) hostingFail('HOSTING_PRICING_TABLE_INVALID')
                return n
            }
            const height = span('rowspan'), width = span('colspan'), value = clean(cell[3])
            for (let y = r; y < r + height; y++) {
                grid[y] ??= []
                for (let x = column; x < column + width; x++) {
                    if (x >= 5 || y >= rows.length || grid[y][x] !== undefined) hostingFail('HOSTING_PRICING_TABLE_INVALID')
                    grid[y][x] = value
                }
            }
            column += width
        }
    }
    if (grid.some(row => row.length !== 5 || Array.from({ length: 5 }, (_, i) => row[i]).some(value => value === undefined)) || grid[0].join('|') !== 'MODEL|MODEL|MODEL|deepseek-flash|deepseek-v4-pro') hostingFail('HOSTING_PRICING_TABLE_AMBIGUOUS')
    const unique = (label: string) => {
        const found = grid.filter(row => row[0] === label)
        if (found.length !== 1) hostingFail('HOSTING_PRICING_TABLE_AMBIGUOUS')
        return found[0]
    }
    const contexts = unique('CONTEXT LENGTH'), thinking = unique('THINKING MODE')
    if ([3, 4].some(column => contexts[column] !== '1M' || !thinking[column].includes('non-thinking and thinking'))) hostingFail('HOSTING_PRICING_CAPABILITY_UNVERIFIED')
    for (const feature of ['Json Output', 'Tool Calls']) {
        const found = grid.filter(row => row[0] === 'FEATURES' && row[1] === feature)
        if (found.length !== 1 || found[0][3] !== '✓' || found[0][4] !== '✓') hostingFail('HOSTING_PRICING_CAPABILITY_UNVERIFIED')
    }
    const versions = unique('MODEL VERSION')
    const extract = (column: number) => {
        const rates = (band: 'PEAK' | 'OFF-PEAK') => {
            const quantity = (label: string) => {
                const found = grid.filter(row => row[0] === 'PRICING' && row[1] === label && row[2] === band)
                if (found.length !== 1 || !/^\$\d+(?:\.\d{1,6})?$/.test(found[0][column])) hostingFail('HOSTING_PRICING_RATE_INVALID')
                const [whole, fraction = ''] = found[0][column].slice(1).split('.')
                return Number(BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0')))
            }
            return PricingRates.parse({ cacheHit: quantity('1M INPUT TOKENS (CACHE HIT)'), cacheMiss: quantity('1M INPUT TOKENS (CACHE MISS)'), output: quantity('1M OUTPUT TOKENS') })
        }
        const peak = rates('PEAK'), offPeak = rates('OFF-PEAK')
        if (peak.cacheHit > peak.cacheMiss || Object.keys(peak).some(key => peak[key as keyof typeof peak] !== offPeak[key as keyof typeof peak] * 2)) hostingFail('HOSTING_PRICING_RATE_INVALID')
        return { peak, offPeak, version: versions[column] }
    }
    const terms = PricingTerms.parse({ parserVersion: 'deepseek-html-v1', schedule: 'weekdays-utc-01-04-06-10-except-cn-holidays', models: { [HOSTED_DEEPSEEK_MODEL]: extract(3), [HOSTED_DEEPSEEK_PRO_MODEL]: extract(4) }, table: grid })
    return { terms, termsHash: hash(terms), contentHash: hash(source.html), sourceAt, sourceValidation: source.sourceValidation ?? null }
}
export function pricingBand(now: Date): 'peak' | 'offPeak' {
    const weekday = now.getUTCDay(), hour = now.getUTCHours()
    return weekday > 0 && weekday < 6 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? 'peak' : 'offPeak'
}
export function pricingBandBounds(now: Date): { from: Date, until: Date } {
    const ms = now.getTime(), day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const boundaries = Array.from({ length: 5 }, (_, d) => d - 2).flatMap(d => [0, 1, 4, 6, 10, 24].map(hour => day + d * 86_400_000 + hour * 3_600_000)).sort((a, b) => a - b)
    return { from: new Date(Math.max(...boundaries.filter(value => value <= ms))), until: new Date(Math.min(...boundaries.filter(value => value > ms))) }
}
function clean(value: string): string {
    return value.replace(/<sup\b[^]*?<\/sup\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().normalize('NFKC')
}
function hash(value: unknown): string {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex') 
}
