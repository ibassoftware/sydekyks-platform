import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { DataSource, EntityManager } from 'typeorm'
import { z } from 'zod'
import { assertHostingOperator } from './hosting-access-policy'
import { HOSTED_AI_TIMEOUT_MS, HostedAiPrice, validateHostedAiQuote } from './hosting-ai-policy'
import { ManagedModel, PricingApprovalEntity, PricingObservation, PricingObservationEntity, PricingState, PricingStateEntity } from './hosting-pricing-entities'
import { fetchOfficialPricing, HOSTED_PRICING_URL, parseOfficialPricing, PRICING_CALENDAR, PRICING_FRESH_MS, pricingBand, pricingBandBounds, PricingFetcher, PricingSourceValidation, PricingTerms } from './hosting-pricing-source'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const STATE_ID = 'managed-pricing-v1'
export const PricingApprovalInput = z.strictObject({ expectedRevision: z.number().int().nonnegative(), observationId: z.string().length(21), termsHash: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), validUntil: z.iso.datetime(), calendarVersion: z.literal(PRICING_CALENDAR.version) })
export type PricingApprovalInput = z.infer<typeof PricingApprovalInput>

export function createHostedPricing({ dataSource, fetchSource = fetchOfficialPricing }: { dataSource: DataSource, fetchSource?: PricingFetcher }) {
    async function observe(signal?: AbortSignal): Promise<void> {
        const fence = await tx.run({ dataSource, fn: async manager => {
            const state = await lockedState(manager)
            const now = await tx.now(manager)
            if (state.fetchFence && state.leaseUntil && state.leaseUntil > now) return null
            const key = apId()
            await manager.getRepository(PricingStateEntity).update({ id: state.id }, { fetchFence: key, leaseUntil: new Date(now.getTime() + 15_000), status: 'checking' })
            return key
        } })
        if (!fence) return
        let source: Awaited<ReturnType<PricingFetcher>> | null = null
        try {
            source = await fetchSource(signal) 
        }
        catch { /* Record a durable failure below; never retain an old successful authority. */ }
        await tx.run({ dataSource, fn: async manager => {
            const state = await lockedState(manager)
            const now = await tx.now(manager)
            let result: PricingObservation
            try {
                if (!source) hostingFail('HOSTING_PRICING_SOURCE_UNAVAILABLE')
                const parsed = parseOfficialPricing(source, now)
                result = await manager.getRepository(PricingObservationEntity).save({ id: apId(), fence, state: 'verified', ...parsed, observedAt: now, reason: null })
            }
            catch {
                result = await manager.getRepository(PricingObservationEntity).save({ id: apId(), fence, state: 'error', terms: null, termsHash: null, contentHash: null, observedAt: now, sourceAt: null, sourceValidation: PricingSourceValidation.safeParse(source?.sourceValidation).data ?? null, reason: 'Official pricing could not be freshly verified. Check the source and retry.' })
            }
            // An older/expired worker may record evidence but cannot overwrite a
            // newer failure or confirmation from another API process.
            if (state.fetchFence !== fence || !state.leaseUntil || state.leaseUntil <= now) return
            const approval = state.approvalId ? await manager.getRepository(PricingApprovalEntity).findOneBy({ id: state.approvalId }) : null
            const status = result.state === 'error' ? 'error' : !approval ? 'needs_approval' : approval.termsHash === result.termsHash ? 'ready' : 'mismatch'
            await manager.getRepository(PricingStateEntity).update({ id: state.id }, { fetchFence: null, leaseUntil: null, observationId: result.id, status })
        } })
    }
    async function approve({ actor, input }: { actor: HostingActor, input: PricingApprovalInput }): Promise<void> {
        const value = PricingApprovalInput.parse(input), payloadHash = digest(value)
        await tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const state = await lockedState(manager)
            const existing = await manager.getRepository(PricingApprovalEntity).findOneBy({ identityId: actor.identityId, requestKey: value.requestKey })
            if (existing) {
                if (existing.payloadHash !== payloadHash) hostingFail('HOSTING_PRICING_IDEMPOTENCY_CONFLICT')
                return
            }
            if (state.revision !== value.expectedRevision) hostingFail('HOSTING_PRICING_REVISION_CONFLICT')
            const now = await tx.now(manager)
            const observation = state.observationId ? await manager.getRepository(PricingObservationEntity).findOneBy({ id: state.observationId }) : null
            if (!observation || observation.id !== value.observationId || observation.termsHash !== value.termsHash || !fresh(observation, now) || !['ready', 'needs_approval', 'mismatch'].includes(state.status)) hostingFail('HOSTING_PRICING_FRESH_OBSERVATION_REQUIRED')
            const validUntil = new Date(value.validUntil)
            if (now < new Date(PRICING_CALENDAR.from) || now >= new Date(PRICING_CALENDAR.until) || validUntil <= new Date(now.getTime() + HOSTED_AI_TIMEOUT_MS + 5000) || validUntil > new Date(PRICING_CALENDAR.until)) hostingFail('HOSTING_PRICING_CALENDAR_COVERAGE_REQUIRED')
            const approval = await manager.getRepository(PricingApprovalEntity).save({ id: apId(), observationId: observation.id, termsHash: value.termsHash, calendarVersion: value.calendarVersion, identityId: actor.identityId, requestKey: value.requestKey, payloadHash, validFrom: now, validUntil })
            await manager.getRepository(PricingStateEntity).update({ id: state.id }, { approvalId: approval.id, revision: state.revision + 1, status: 'ready' })
        } })
    }
    return { observe, approve }
}

export async function readApprovedPricing(manager: EntityManager, now: Date, model: ManagedModel): Promise<HostedAiPrice> {
    const { state, approval, observation, terms } = await authority(manager, now)
    const band = pricingBand(now), boundary = pricingBandBounds(now)
    const validFrom = new Date(Math.max(observation.observedAt.getTime(), observation.sourceAt!.getTime(), approval.validFrom.getTime(), boundary.from.getTime(), Date.parse(PRICING_CALENDAR.from)))
    const validUntil = new Date(Math.min(observation.observedAt.getTime() + PRICING_FRESH_MS, observation.sourceAt!.getTime() + PRICING_FRESH_MS, approval.validUntil.getTime(), Date.parse(PRICING_CALENDAR.until), boundary.until.getTime(), validFrom.getTime() + 3_600_000))
    return validateHostedAiQuote({ version: `pricing:${state.approvalId}:${observation.id}:${band}`, model, validFrom: validFrom.toISOString(), validUntil: validUntil.toISOString(), rates: terms.models[model][band], ceiling: terms.models[model].peak }, now)
}
export async function assertPreparedPricing(manager: EntityManager, quote: HostedAiPrice, now: Date): Promise<void> {
    validateHostedAiQuote(quote, now)
    const { approval, terms } = await authority(manager, now)
    const match = /^pricing:([a-zA-Z0-9_-]{21}):([a-zA-Z0-9_-]{21}):(peak|offPeak)$/.exec(quote.version)
    if (!match || match[1] !== approval.id) hostingFail('HOSTING_AI_PRICE_CHANGED')
    const original = await manager.getRepository(PricingObservationEntity).findOneBy({ id: match[2] })
    if (!original || !fresh(original, now) || original.termsHash !== approval.termsHash) hostingFail('HOSTING_AI_PRICE_EXPIRED')
    const boundary = pricingBandBounds(new Date(quote.validFrom)), band = pricingBand(new Date(quote.validFrom))
    if (band !== match[3] || quote.model === undefined || digest(quote.rates) !== digest(terms.models[quote.model][band]) || digest(quote.ceiling) !== digest(terms.models[quote.model].peak) || new Date(quote.validUntil) > boundary.until || new Date(quote.validUntil) > approval.validUntil || new Date(quote.validUntil).getTime() > Math.min(original.observedAt.getTime(), original.sourceAt!.getTime()) + PRICING_FRESH_MS) hostingFail('HOSTING_AI_PRICE_CHANGED')
}
export async function hostedPricingView(manager: EntityManager, now: Date) {
    const state = await manager.getRepository(PricingStateEntity).findOneBy({ id: STATE_ID })
    const observation = state?.observationId ? await manager.getRepository(PricingObservationEntity).findOneBy({ id: state.observationId }) : null
    const approval = state?.approvalId ? await manager.getRepository(PricingApprovalEntity).findOneBy({ id: state.approvalId }) : null
    let status: string = state?.status ?? 'unconfigured'
    if (['ready', 'needs_approval', 'mismatch'].includes(status) && (!observation || !fresh(observation, now) || (approval && approval.validUntil <= now) || now < new Date(PRICING_CALENDAR.from) || now >= new Date(PRICING_CALENDAR.until))) status = 'expired'
    return { status, revision: state?.revision ?? 0, observationId: observation?.id ?? null, termsHash: observation?.termsHash ?? null, observedAt: observation?.observedAt.toISOString() ?? null, sourceValidUntil: observation?.sourceAt ? new Date(Math.min(observation.sourceAt.getTime(), observation.observedAt.getTime()) + PRICING_FRESH_MS).toISOString() : null, sourceUrl: HOSTED_PRICING_URL, calendar: PRICING_CALENDAR, terms: observation?.terms ? { models: observation.terms.models } : null, approval: approval ? { id: approval.id, validUntil: approval.validUntil.toISOString(), termsHash: approval.termsHash } : null }
}
async function authority(manager: EntityManager, now: Date) {
    const state = await manager.getRepository(PricingStateEntity).findOne({ where: { id: STATE_ID }, lock: { mode: 'pessimistic_read' } })
    if (!state || state.status !== 'ready' || !state.approvalId || !state.observationId) hostingFail('HOSTING_MANAGED_PRICING_UNAVAILABLE')
    const approval = await manager.getRepository(PricingApprovalEntity).findOneBy({ id: state.approvalId })
    const observation = await manager.getRepository(PricingObservationEntity).findOneBy({ id: state.observationId })
    if (!approval || !observation || !fresh(observation, now) || approval.termsHash !== observation.termsHash || approval.calendarVersion !== PRICING_CALENDAR.version || approval.validFrom > now || approval.validUntil <= now || now < new Date(PRICING_CALENDAR.from) || now >= new Date(PRICING_CALENDAR.until)) hostingFail('HOSTING_MANAGED_PRICING_UNAVAILABLE')
    return { state, approval, observation, terms: PricingTerms.parse(observation.terms) }
}
function fresh(observation: PricingObservation, now: Date): boolean {
    return observation.state === 'verified' && !!observation.sourceAt && !!observation.terms && observation.observedAt <= now && observation.sourceAt <= new Date(now.getTime() + 30_000) && now.getTime() - observation.observedAt.getTime() < PRICING_FRESH_MS && now.getTime() - observation.sourceAt.getTime() < PRICING_FRESH_MS
}
async function lockedState(manager: EntityManager): Promise<PricingState> {
    await manager.getRepository(PricingStateEntity).createQueryBuilder().insert().values({ id: STATE_ID, revision: 0, approvalId: null, observationId: null, fetchFence: null, leaseUntil: null, status: 'unconfigured' }).orIgnore().execute()
    return manager.getRepository(PricingStateEntity).findOneOrFail({ where: { id: STATE_ID }, lock: { mode: 'pessimistic_write' } })
}
function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex') 
}
