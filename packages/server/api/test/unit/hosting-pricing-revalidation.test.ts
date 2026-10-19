import { readFileSync } from 'node:fs'
import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { SydekyksPricingValidation1893000000000 } from '../../src/app/database/migration/postgres/1893000000000-SydekyksPricingValidation'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HOSTED_AI_TIMEOUT_MS } from '../../src/app/hosting/hosting-ai-policy'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { assertPreparedPricing, createHostedPricing, hostedPricingView, readApprovedPricing } from '../../src/app/hosting/hosting-pricing'
import { PricingApprovalEntity, PricingObservationEntity } from '../../src/app/hosting/hosting-pricing-entities'
import { createOfficialPricingFetcher, HOSTED_PRICING_URL, parseOfficialPricing, PRICING_CALENDAR, PricingHttpTransport } from '../../src/app/hosting/hosting-pricing-source'
import { PRICING_FRESH_MS, PRICING_HTTP_DEADLINE_MS, PRICING_MIN_REFRESH_VALIDITY_MS, PRICING_REFRESH_MS } from '../../src/app/hosting/hosting-pricing-timing'
import { hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const html = readFileSync(new URL('../fixtures/hosting-official-pricing.html', import.meta.url), 'utf8')
const etag = '"reviewed-exact-representation"'
type Response = Awaited<ReturnType<PricingHttpTransport>>
function response(status = 200, data = status === 304 ? '' : html, headers: Record<string, unknown> = {}): Response {
    return { status, data, headers: { 'content-type': 'text/html; charset=utf-8', date: new Date().toUTCString(), etag, ...headers } }
}
function sequence(responses: Response[]) {
    const request = vi.fn<PricingHttpTransport>(async () => {
        const next = responses.shift()
        if (!next) throw new Error('Unexpected third request')
        return next
    })
    return { request, fetch: createOfficialPricingFetcher(request) }
}

describe('official pricing conditional HTTP validation', () => {
    it('accepts a fresh200 using one fixed-origin bounded request and preserves actual metadata', async () => {
        const { request, fetch } = sequence([response(200, html, { age: '0' })])
        const source = await fetch()
        expect(source.sourceValidation?.mode).toBe('fresh_200')
        expect(request).toHaveBeenCalledTimes(1)
        expect(request.mock.calls[0][0]).toMatchObject({ method: 'GET', url: HOSTED_PRICING_URL, maxRedirects: 0, maxContentLength: 524288, maxBodyLength: 0, headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' } })
        expect(request.mock.calls[0][0].timeout).toBeGreaterThan(0)
        expect(request.mock.calls[0][0].timeout).toBeLessThanOrEqual(10000)
        expect(source.age).toBe('0')
        expect(parseOfficialPricing(source, new Date()).sourceValidation).toEqual(source.sourceValidation)
    })
    it('revalidates a seven-minute cached200 before it can expire ahead of the next refresh', async () => {
        const { request, fetch } = sequence([response(200, html, { age: '420' }), response(304)])
        const source = await fetch(), parsed = parseOfficialPricing(source, new Date())
        expect(request).toHaveBeenCalledTimes(2)
        expect(source.sourceValidation?.mode).toBe('revalidated_304')
        expect(source.sourceValidation?.requests[0].age).toBe('420')
        expect(source.sourceValidation?.requests[1].age).toBeNull()
        expect(Date.now() - parsed.sourceAt.getTime()).toBeLessThan(2000)
        expect(request.mock.calls[1][0].headers['If-None-Match']).toBe(etag)
    })
    it('keeps young cached source age and strict expiry instead of resetting it to observation time', async () => {
        const { request, fetch } = sequence([response(200, html, { age: '180' })])
        const source = await fetch(), now = new Date(), parsed = parseOfficialPricing(source, now)
        const requestedAt = Date.parse(source.sourceValidation!.requests[0].requestedAt)
        expect(request).toHaveBeenCalledTimes(1)
        expect(source.sourceValidation?.mode).toBe('fresh_200')
        expect(parsed.sourceAt.getTime()).toBe(requestedAt - 180_000)
        expect(() => parseOfficialPricing(source, new Date(parsed.sourceAt.getTime() + PRICING_FRESH_MS))).toThrow('SOURCE_STALE')
    })
    it('requires conditional origin proof at the exact refresh-headroom boundary', async () => {
        const age = String((PRICING_FRESH_MS - PRICING_MIN_REFRESH_VALIDITY_MS) / 1000)
        const { request, fetch } = sequence([response(200, html, { age }), response(304)])
        expect((await fetch()).sourceValidation?.mode).toBe('revalidated_304')
        expect(request).toHaveBeenCalledTimes(2)
        const noValidator = sequence([response(200, html, { age, etag: undefined })])
        await expect(noValidator.fetch()).rejects.toThrow('STALE')
        expect(noValidator.request).toHaveBeenCalledTimes(1)
    })
    it.each([200, 304])('rejects conditional%s with insufficient freshness even inside the ten-minute validity window', async status => {
        const { request, fetch } = sequence([response(200, html, { age: '420' }), response(status, status === 304 ? '' : html, { age: '300' })])
        await expect(fetch()).rejects.toThrow()
        expect(request).toHaveBeenCalledTimes(2)
    })
    it('revalidates a stale200 only with exact same URL/variant and matching empty304 proof', async () => {
        const { request, fetch } = sequence([response(200, html, { age: '42000' }), response(304)])
        const source = await fetch(), parsed = parseOfficialPricing(source, new Date())
        expect(source.sourceValidation?.mode).toBe('revalidated_304')
        expect(source.html).toBe(html)
        expect(source.age).toBeUndefined()
        expect(source.sourceValidation?.requests[0].age).toBe('42000')
        expect(source.sourceValidation?.requests[1]).toMatchObject({ status: 304, age: null, etag, bodyBytes: 0 })
        expect(Date.now() - parsed.sourceAt.getTime()).toBeLessThan(2000)
        expect(request).toHaveBeenCalledTimes(2)
        expect(request.mock.calls[1][0].headers).toEqual({ ...request.mock.calls[0][0].headers, 'If-None-Match': etag })
        expect(request.mock.calls[1][0].url).toBe(request.mock.calls[0][0].url)
        expect(request.mock.calls[1][0].signal).toBe(request.mock.calls[0][0].signal)
    })
    it('uses a changed conditional200 body and its own headers, without retaining the stale body', async () => {
        const changed = html.replace('$0.003', '$0.004').replace('$0.006', '$0.008')
        const { fetch } = sequence([response(200, html, { age: '601' }), response(200, changed, { etag: '"changed-representation"', age: '0' })])
        const source = await fetch()
        expect(source.html).toBe(changed)
        expect(source.sourceValidation?.mode).toBe('conditional_200')
        expect(parseOfficialPricing(source, new Date()).terms.models['deepseek-flash'].peak.cacheHit).toBe(8000)
        expect(source.sourceValidation?.requests[0].contentHash).not.toBe(source.sourceValidation?.requests[1].contentHash)
    })
    it.each([undefined, 'W/"weak"', 'unquoted', '"one", "two"'])('never sends a conditional request using invalid/weak initial ETag %s', async tag => {
        const { request, fetch } = sequence([response(200, html, { age: '601', etag: tag })])
        await expect(fetch()).rejects.toThrow('STALE')
        expect(request).toHaveBeenCalledTimes(1)
    })
    it.each([undefined, 'W/"reviewed-exact-representation"', '"different"'])('refuses missing/weak/mismatched304 ETag %s', async tag => {
        const { fetch } = sequence([response(200, html, { age: '601' }), response(304, '', { etag: tag })])
        await expect(fetch()).rejects.toThrow()
    })
    it.each([{ age: '601' }, { age: '-1' }, { age: '0,0' }, { date: undefined }, { date: 'invalid' }, { date: new Date(Date.now() + 60000).toUTCString() }, { vary: '*' }, { vary: 'Origin' }])('refuses invalid304 metadata %j', async headers => {
        const { fetch } = sequence([response(200, html, { age: '601' }), response(304, '', headers)])
        await expect(fetch()).rejects.toThrow()
    })
    it('rejects nonempty304 bodies and explicit Vary changes', async () => {
        await expect(sequence([response(200, html, { age: '601' }), response(304, 'unexpected')]).fetch()).rejects.toThrow('REVALIDATION_INVALID')
        await expect(sequence([response(200, html, { age: '601', vary: 'Accept' }), response(304, '', { vary: 'Accept-Encoding' })]).fetch()).rejects.toThrow('REVALIDATION_INVALID')
        const source = await sequence([response(200, html, { age: '601', vary: 'Accept, Accept-Encoding' }), response(304, '', { vary: 'accept-encoding, accept' })]).fetch()
        expect(source.sourceValidation?.mode).toBe('revalidated_304')
    })
    it.each([301, 302, 500])('refuses status%s with no redirect or retry', async status => {
        const { request, fetch } = sequence([response(status)])
        await expect(fetch()).rejects.toThrow('UNAVAILABLE')
        expect(request).toHaveBeenCalledTimes(1)
    })
    it.each([{ date: undefined }, { date: 'invalid' }, { age: 'invalid' }, { vary: '*' }, { vary: 'Accept-Language' }])('does not fabricate or repair initial response metadata %j', async headers => {
        const { request, fetch } = sequence([response(200, html, headers)])
        await expect(fetch()).rejects.toThrow()
        expect(request).toHaveBeenCalledTimes(1)
    })
    it('counts request delay and residence in freshness and binds proof to the exact body', async () => {
        const source = await createOfficialPricingFetcher(async () => {
            await new Promise(resolve => setTimeout(resolve, 15))
            return response(200, html, { age: '5' })
        })()
        const parsed = parseOfficialPricing(source, new Date()), requestAt = Date.parse(source.sourceValidation!.requests[0].requestedAt)
        expect(parsed.sourceAt.getTime()).toBe(requestAt - 5000)
        expect(() => parseOfficialPricing({ ...source, html: html + 'tampered' }, new Date())).toThrow('SOURCE_INVALID')
    })
    it('never makes a third request or silently refreshes a stale conditional200', async () => {
        const { request, fetch } = sequence([response(200, html, { age: '601' }), response(200, html, { age: '601' })])
        await expect(fetch()).rejects.toThrow('STALE')
        expect(request).toHaveBeenCalledTimes(2)
    })
    it('honors already-aborted and in-progress caller cancellation', async () => {
        const controller = new AbortController(), never = vi.fn<PricingHttpTransport>()
        controller.abort()
        await expect(createOfficialPricingFetcher(never)(controller.signal)).rejects.toThrow('ABORTED')
        expect(never).not.toHaveBeenCalled()
        const active = new AbortController()
        let secondSignal: AbortSignal | undefined
        const request = vi.fn<PricingHttpTransport>(async params => {
            if (request.mock.calls.length === 1) return response(200, html, { age: '601' })
            secondSignal = params.signal
            active.abort()
            return new Promise(() => {})
        })
        await expect(createOfficialPricingFetcher(request)(active.signal)).rejects.toThrow('ABORTED')
        expect(secondSignal?.aborted).toBe(true)
        expect(request).toHaveBeenCalledTimes(2)
    })
    it('shares one10second deadline across both requests even when transport does not honor its timeout', async () => {
        const started = Date.now()
        let remaining = 10000, secondSignal: AbortSignal | undefined
        const request = vi.fn<PricingHttpTransport>(async params => {
            if (request.mock.calls.length === 1) {
                await new Promise(resolve => setTimeout(resolve, 8000))
                return response(200, html, { age: '601' })
            }
            remaining = params.timeout; secondSignal = params.signal
            return new Promise(() => {})
        })
        await expect(createOfficialPricingFetcher(request)()).rejects.toThrow('ABORTED')
        expect(Date.now() - started).toBeLessThan(11500)
        expect(remaining).toBeLessThan(2500)
        expect(secondSignal?.aborted).toBe(true)
        expect(request).toHaveBeenCalledTimes(2)
    }, 12000)
})

describe('persisted pricing validation evidence', () => {
    let ds: DataSource
    beforeAll(async () => {
        ds = await migratedHostedPGlite()
    })
    afterAll(async () => {
        if (ds?.isInitialized) await ds.destroy(); vi.unstubAllEnvs()
    })
    it('keeps approval and prepared quotes on equivalent304 proof, persists immutable provenance, and stops on changed200', async () => {
        await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
        const id = apId()
        await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', verified: true, password: 'unused', firstName: 'Pricing', lastName: 'Fixture', tokenVersion: 'initial' })
        const tenant = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-pricing-proof-subject-at-least32characters' }), id)
        vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', id)
        const actor = { identityId: id, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion }
        let fetch = sequence([response()]).fetch
        const pricing = createHostedPricing({ dataSource: ds, fetchSource: signal => fetch(signal) })
        const view = () => tx.run({ dataSource: ds, fn: async manager => hostedPricingView(manager, await tx.now(manager)) })
        await pricing.observe()
        const before = await view()
        await pricing.approve({ actor, input: { expectedRevision: before.revision, observationId: before.observationId!, termsHash: before.termsHash!, requestKey: apId(), validUntil: PRICING_CALENDAR.until, calendarVersion: PRICING_CALENDAR.version } })
        const quote = await tx.run({ dataSource: ds, fn: async manager => readApprovedPricing(manager, await tx.now(manager), 'deepseek-flash') })
        const approval = (await view()).approval
        // Worst accepted whole-second cache age: just below 3m30. Preserve its
        // actual source age; allow the next five-minute timer, full HTTP deadline
        // and 15 seconds scheduling delay while retaining the 65-second quote window.
        const ageLimitSeconds = (PRICING_FRESH_MS - PRICING_MIN_REFRESH_VALIDITY_MS) / 1000
        expect(ageLimitSeconds).toBe(210)
        expect(PRICING_MIN_REFRESH_VALIDITY_MS - PRICING_REFRESH_MS - PRICING_HTTP_DEADLINE_MS - 15_000).toBeGreaterThanOrEqual(HOSTED_AI_TIMEOUT_MS + 5000)
        const worstAccepted = sequence([response(200, html, { age: String(ageLimitSeconds - 1) })])
        fetch = worstAccepted.fetch
        await pricing.observe()
        const cached = await view(), cachedObservation = await ds.getRepository(PricingObservationEntity).findOneByOrFail({ id: cached.observationId! })
        expect(worstAccepted.request).toHaveBeenCalledTimes(1)
        expect(cachedObservation.sourceValidation?.mode).toBe('fresh_200')
        expect(cached.approval).toEqual(approval)
        const slowNextTick = new Date(cachedObservation.observedAt.getTime() + PRICING_REFRESH_MS + PRICING_HTTP_DEADLINE_MS + 15_000)
        const cachedQuote = await tx.run({ dataSource: ds, fn: manager => readApprovedPricing(manager, slowNextTick, 'deepseek-flash') })
        expect(new Date(cachedQuote.validUntil).getTime() - slowNextTick.getTime()).toBeGreaterThanOrEqual(HOSTED_AI_TIMEOUT_MS + 5000)
        fetch = sequence([response(200, html, { age: '420' }), response(304)]).fetch
        await pricing.observe()
        const after = await view()
        expect(after.status).toBe('ready')
        expect(after.termsHash).toBe(before.termsHash)
        expect(after.approval).toEqual(approval)
        expect(await ds.getRepository(PricingApprovalEntity).count()).toBe(1)
        await tx.run({ dataSource: ds, fn: async manager => assertPreparedPricing(manager, quote, await tx.now(manager)) })
        const observation = await ds.getRepository(PricingObservationEntity).findOneByOrFail({ id: after.observationId! })
        // The same approved provider remains price-authorized across the next
        // scheduled tick, including ten seconds of transport/scheduling delay.
        // The prior implementation accepted Age420 and expired after180seconds.
        const nextTick = new Date(observation.observedAt.getTime() + PRICING_REFRESH_MS + 10_000)
        const nextQuote = await tx.run({ dataSource: ds, fn: manager => readApprovedPricing(manager, nextTick, 'deepseek-flash') })
        expect(new Date(nextQuote.validUntil).getTime()).toBeGreaterThan(nextTick.getTime())
        expect((await tx.run({ dataSource: ds, fn: manager => hostedPricingView(manager, nextTick) })).status).toBe('ready')
        const expires = new Date(Math.min(observation.observedAt.getTime(), observation.sourceAt!.getTime()) + PRICING_FRESH_MS)
        await expect(tx.run({ dataSource: ds, fn: manager => readApprovedPricing(manager, expires, 'deepseek-flash') })).rejects.toThrow('PRICING_UNAVAILABLE')
        expect(observation.sourceValidation?.mode).toBe('revalidated_304')
        expect(observation.sourceValidation!.requests.map(item => item.status)).toEqual([200, 304])
        expect(JSON.stringify(after)).not.toContain('sourceValidation')
        await expect(ds.getRepository(PricingObservationEntity).update({ id: observation.id }, { sourceValidation: null })).rejects.toThrow('HISTORY_IMMUTABLE')
        const runner = ds.createQueryRunner()
        try {
            await runner.startTransaction()
            await expect(new SydekyksPricingValidation1893000000000().down(runner)).rejects.toThrow('EMPTY_PROVENANCE')
        }
        finally {
            await runner.rollbackTransaction(); await runner.release()
        }
        fetch = sequence([response(200, html, { age: '601' }), response(200, html.replace('$0.003', '$0.004').replace('$0.006', '$0.008'))]).fetch
        await pricing.observe()
        expect((await view()).status).toBe('mismatch')
        expect((await view()).approval).toEqual(approval)
        await expect(tx.run({ dataSource: ds, fn: async manager => readApprovedPricing(manager, await tx.now(manager), 'deepseek-flash') })).rejects.toThrow('PRICING_UNAVAILABLE')
    })
})
