import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { EngineResponseStatus, FlowRunStatus } from '@activepieces/shared'
import { DataSource, EntityManager, In } from 'typeorm'
import { z } from 'zod'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { hostedAiCost, HostedAiQuote } from './hosting-ai-policy'
import { HostingChargeResolutionEntity } from './hosting-charge-resolution-entities'
import { HOSTED_LEGACY_MICRO_USD_PER_CREDIT, hostedAiCredits, hostedUsesCreditAccounting } from './hosting-credit-policy'
import { HostingDispatch, HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingAccountEntity, HostingReservationEntity } from './hosting-entities'
import { hostedInclusiveCredits, hostedInclusiveExposure } from './hosting-inclusive-credits'
import { HostingRootCreditUsageEntity } from './hosting-inclusive-credits-entity'
import { createHostedLedger, lockHostedBudget } from './hosting-ledger'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const id = z.string().length(21)
const usageSchema = z.strictObject({ prompt_cache_hit_tokens: z.number().int().min(0).max(10_000_000), prompt_cache_miss_tokens: z.number().int().min(0).max(10_000_000), completion_tokens: z.number().int().min(0).max(10_000_000) })
export const ChargeResolutionDraft = z.strictObject({
    platformId: id, rootReservationId: id, outcome: z.enum(['verified_usage', 'confirmed_not_sent', 'retain']),
    reason: z.string().trim().min(10).max(1000), evidenceReference: z.string().trim().min(10).max(1000),
    billable: z.boolean().optional(), supplierCreatedAt: z.iso.datetime().optional(), supplierRequestId: z.string().trim().min(1).max(200).optional(), usage: usageSchema.optional(),
}).superRefine((input, context) => {
    if (input.outcome === 'verified_usage' && ((!input.usage && input.billable === undefined) || !input.supplierRequestId || !input.supplierCreatedAt)) context.addIssue({ code: 'custom', message: 'Supplier receipt and usage required' })
    if (input.outcome !== 'verified_usage' && (input.usage || input.billable !== undefined)) context.addIssue({ code: 'custom', message: 'Usage is only valid for verified usage' })
})
export const ChargeResolutionCommand = ChargeResolutionDraft.safeExtend({ expectedRevision: z.number().int().min(0).max(999), expectedState: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/) })
export type ChargeResolutionDraftInput = z.infer<typeof ChargeResolutionDraft>
type Context = Awaited<ReturnType<typeof contextOf>>

export function createHostedChargeResolution({ dataSource }: { dataSource: DataSource }) {
    async function list({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await tx.account({ manager, platformId })
            const user = await assertHostingOperator({ manager, actor })
            const calls = await manager.getRepository(HostingModelCallEntity).find({ where: { platformId, state: In(['uncertain', 'running', 'prepared']) }, take: 101, order: { created: 'ASC', id: 'ASC' } })
            const views = []
            for (const call of calls.slice(0, 100)) views.push(await viewOf(await contextOf(manager, call.id, platformId), actor, user.id))
            return { identity: identity(actor, user.id), platformId, calls: views, hasMore: calls.length > 100 }
        } })
    }
    async function read({ actor, platformId, callId }: { actor: HostingActor, platformId: string, callId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await tx.account({ manager, platformId })
            const user = await assertHostingOperator({ manager, actor })
            return viewOf(await contextOf(manager, callId, platformId), actor, user.id)
        } })
    }
    async function preview({ actor, callId, input: raw }: { actor: HostingActor, callId: string, input: ChargeResolutionDraftInput }) {
        const input = ChargeResolutionDraft.parse(raw)
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await tx.account({ manager, platformId: input.platformId })
            const user = await assertHostingOperator({ manager, actor })
            const context = await contextOf(manager, callId, input.platformId, input.rootReservationId)
            return { view: await viewOf(context, actor, user.id), preview: project(context, input) }
        } })
    }
    async function resolve({ actor, callId, input: raw }: { actor: HostingActor, callId: string, input: z.infer<typeof ChargeResolutionCommand> }) {
        const input = ChargeResolutionCommand.parse(raw), draft = ChargeResolutionDraft.parse({ platformId: input.platformId, rootReservationId: input.rootReservationId, outcome: input.outcome, reason: input.reason, evidenceReference: input.evidenceReference, ...(input.supplierCreatedAt ? { supplierCreatedAt: input.supplierCreatedAt } : {}), ...(input.supplierRequestId ? { supplierRequestId: input.supplierRequestId } : {}), ...(input.usage ? { usage: input.usage } : {}), ...(input.billable !== undefined ? { billable: input.billable } : {}) }), requestHash = hash({ callId, input })
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const peek = await manager.getRepository(HostingModelCallEntity).findOneBy({ id: callId, platformId: input.platformId })
            if (!peek) hostingFail('HOSTING_CHARGE_NOT_FOUND')
            // Same order as supplier settlement; the persisted original day is used.
            if (peek.budgetDay) await lockHostedBudget({ manager, day: peek.budgetDay, create: false })
            await tx.account({ manager, platformId: input.platformId })
            const user = await assertHostingOperator({ manager, actor })
            const previous = await manager.getRepository(HostingChargeResolutionEntity).findOneBy({ operatorIdentityId: actor.identityId, requestKey: input.requestKey })
            if (previous) {
                if (previous.requestHash !== requestHash) hostingFail('HOSTING_CHARGE_RESOLUTION_CONFLICT')
                return { view: await viewOf(await contextOf(manager, callId, input.platformId, input.rootReservationId), actor, user.id), replayed: true, auditId: previous.id }
            }
            const context = await contextOf(manager, callId, input.platformId, input.rootReservationId), projection = project(context, draft)
            if (context.revision !== input.expectedRevision || projection.expectedState !== input.expectedState) hostingFail('HOSTING_CHARGE_RESOLUTION_CONFLICT')
            if (context.revision >= 1000 || (input.outcome === 'retain' && context.revision >= 999)) hostingFail('HOSTING_CHARGE_RESOLUTION_LIMIT')
            if (!['prepared', 'running', 'uncertain'].includes(context.call.state)) hostingFail('HOSTING_CHARGE_RESOLUTION_UNSAFE')
            if (input.outcome !== 'retain' && !canResolve(context)) hostingFail('HOSTING_CHARGE_RESOLUTION_UNSAFE')
            const auditId = apId(), ledger = createHostedLedger({ dataSource, manager }), call = context.call
            if (input.outcome !== 'retain') {
                if (call.reservationId) {
                    if (!call.dispatchId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
                    if (input.outcome === 'confirmed_not_sent') await ledger.releaseConfirmedNotSent({ platformId: call.platformId, reservationId: call.reservationId, dispatchId: call.dispatchId, resolutionId: auditId })
                    else await ledger.settleManagedCall({ platformId: call.platformId, reservationId: call.reservationId, dispatchId: call.dispatchId, actualCostMicroUsd: BigInt(projection.actualMicroUsd!) })
                }
                const usage = call.nativeTool && input.billable !== undefined ? { successful_requests: input.billable ? 1 : 0 } : input.usage ? { ...input.usage, prompt_tokens: input.usage.prompt_cache_hit_tokens + input.usage.prompt_cache_miss_tokens, total_tokens: input.usage.prompt_cache_hit_tokens + input.usage.prompt_cache_miss_tokens + input.usage.completion_tokens } : null
                await manager.getRepository(HostingModelCallEntity).update({ id: call.id, platformId: call.platformId }, { state: input.outcome === 'verified_usage' ? 'settled' : 'cancelled', fence: apId(), usage, actualMicroUsd: call.payer === 'managed' ? projection.actualMicroUsd : null })
                if (!call.nativeTool && usage && ('prompt_tokens' in usage) && (usage.prompt_tokens > (call.inputTokenBound ?? 1_048_576) || usage.completion_tokens > (call.nativeFeature ? 2048 : 4096))) await manager.getRepository(HostingAccountEntity).update({ id: call.platformId }, { status: 'suspended' })
                if (projection.rootWillSettle) {
                    for (const segment of context.segments.filter(segment => segment.state === 'uncertain')) {
                        await manager.getRepository(HostingDispatchEntity).update({ id: segment.id, platformId: call.platformId }, { state: 'completed', resolutionStatus: FlowRunStatus.FAILED })
                        if (segment.flowRunId) await manager.getRepository(FlowRunEntity).update({ id: segment.flowRunId, projectId: segment.projectId, status: FlowRunStatus.INTERNAL_ERROR }, { status: FlowRunStatus.FAILED, finishTime: context.now.toISOString() })
                    }
                    if (!context.root.dispatchId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
                    await ledger.finishExecution({ platformId: call.platformId, reservationId: context.root.id, dispatchId: context.root.dispatchId })
                }
            }
            await manager.getRepository(HostingChargeResolutionEntity).save({ id: auditId, platformId: call.platformId, callId: call.id, rootReservationId: call.rootReservationId, revision: context.revision + 1, operatorIdentityId: actor.identityId, operatorPlatformId: actor.platformId, operatorUserId: user.id, requestKey: input.requestKey, requestHash, beforeHash: context.stateHash, outcome: input.outcome, reason: input.reason, evidenceReference: input.evidenceReference, supplierRequestId: input.supplierRequestId ?? null, snapshot: context.snapshot, result: { ...projection, supplierCreatedAt: input.supplierCreatedAt ?? null, usage: input.usage ?? null, billable: input.billable ?? null } })
            await tx.event({ manager, platformId: call.platformId, event: 'model_call.operator_resolution', payload: { callId, auditId, outcome: input.outcome, rootSettled: projection.rootWillSettle } })
            return { view: await viewOf(await contextOf(manager, callId, input.platformId), actor, user.id), replayed: false, auditId }
        } })
    }
    return { list, read, preview, resolve }
}

async function contextOf(manager: EntityManager, callId: string, platformId: string, expectedRoot?: string) {
    const call = await manager.getRepository(HostingModelCallEntity).findOneBy({ id: callId, platformId })
    if (!call || (expectedRoot && call.rootReservationId !== expectedRoot)) hostingFail('HOSTING_CHARGE_NOT_FOUND')
    const root = await manager.getRepository(HostingReservationEntity).findOneBy({ id: call.rootReservationId, platformId, kind: 'execution' })
    const segment = await manager.getRepository(HostingDispatchEntity).findOneBy({ id: call.segmentId, platformId, projectId: call.projectId, admissionId: call.admissionId, reservationId: call.rootReservationId })
    if (!root || !segment || root.projectId !== call.projectId || (call.payer === 'managed' && root.payer !== 'managed') || root.identityId !== call.identityId || segment.identityId !== call.identityId) hostingFail('HOSTING_CHARGE_CHAIN_INVALID')
    const rootDispatch = await manager.getRepository(HostingDispatchEntity).findOneBy({ id: segment.rootDispatchId ?? segment.id, platformId, reservationId: root.id })
    if (!rootDispatch || rootDispatch.rootDispatchId || rootDispatch.projectId !== root.projectId || rootDispatch.identityId !== root.identityId) hostingFail('HOSTING_CHARGE_CHAIN_INVALID')
    const segments = await manager.getRepository(HostingDispatchEntity).find({ where: [{ id: rootDispatch.id, platformId }, { rootDispatchId: rootDispatch.id, platformId }], order: { id: 'ASC' } })
    const calls = await manager.getRepository(HostingModelCallEntity).find({ where: { rootReservationId: root.id, platformId }, order: { id: 'ASC' } })
    const reservations = await manager.getRepository(HostingReservationEntity).find({ where: { rootReservationId: root.id, platformId }, order: { id: 'ASC' } })
    const reservation = call.reservationId ? reservations.find(value => value.id === call.reservationId) : null
    if (call.payer === 'managed' ? !reservation || reservation.kind !== 'managed_ai' || reservation.payer !== 'managed' || reservation.identityId !== call.identityId || reservation.projectId !== call.projectId || reservation.dispatchId !== call.dispatchId || reservation.day !== call.budgetDay : call.reservationId !== null || !!reservation || !!call.budgetDay || !!call.quote) hostingFail('HOSTING_CHARGE_CHAIN_INVALID')
    const inclusiveUsage = hostedInclusiveCredits(root) ? await manager.getRepository(HostingRootCreditUsageEntity).findOneBy({ id: root.id, platformId }) : null
    if (hostedInclusiveCredits(root) && !inclusiveUsage) hostingFail('HOSTING_CHARGE_CHAIN_INVALID')
    const history = await manager.getRepository(HostingChargeResolutionEntity).find({ where: { callId }, order: { revision: 'ASC' }, take: 1000 })
    const revision = history.at(-1)?.revision ?? 0, now = await tx.now(manager)
    const snapshot = json({ call: { id: call.id, platformId, projectId: call.projectId, segmentId: call.segmentId, rootReservationId: root.id, state: call.state, fence: call.fence, dispatchId: call.dispatchId, admissionId: call.admissionId, reservationId: call.reservationId, budgetDay: call.budgetDay, quote: call.quote, nativeTool: call.nativeTool, toolUnitPriceMicroUsd: call.toolUnitPriceMicroUsd, toolTariffVersion: call.toolTariffVersion, inputTokenBound: call.inputTokenBound, requestHash: call.requestHash, sentAt: call.sentAt, leaseUntil: call.leaseUntil, payer: call.payer }, root, segments: segments.map(value => ({ id: value.id, state: value.state, leaseUntil: value.leaseUntil, completionStatus: value.completionStatus, terminalReceipt: value.terminalReceipt, resolutionStatus: value.resolutionStatus, waitpointId: value.waitpointId })), calls: calls.map(value => ({ id: value.id, state: value.state, fence: value.fence })), reservations, inclusiveUsage, revision })
    return { call, root, rootDispatch, reservation, segments, calls, reservations, inclusiveUsage, history, revision, now, snapshot, stateHash: hash(snapshot) }
}
function canResolve(context: Context) {
    return context.call.state === 'uncertain' && context.call.leaseUntil <= context.now && context.segments.every(segment => safeTerminal(segment, context.now)) && (!context.reservation || ['running', 'uncertain'].includes(context.reservation.state))
}
function rootBlockers(context: Context): string[] {
    const blockers: string[] = []
    if (context.calls.some(call => call.id !== context.call.id && ['prepared', 'running', 'uncertain'].includes(call.state))) blockers.push('UNRESOLVED_SIBLING_CALL')
    if (context.reservations.some(reservation => reservation.id !== context.call.reservationId && ['reserved', 'running', 'uncertain'].includes(reservation.state))) blockers.push('UNRESOLVED_SIBLING_RESERVATION')
    if (!['running', 'uncertain'].includes(context.root.state)) blockers.push('ROOT_NOT_PENDING')
    if (context.segments.some(segment => !safeTerminal(segment, context.now))) blockers.push('LIVE_OR_UNCONFIRMED_SEGMENT')
    return blockers
}
function safeTerminal(segment: HostingDispatch, now: Date) {
    if (['completed', 'cancelled'].includes(segment.state)) return true
    return segment.state === 'uncertain' && !!segment.leaseUntil && segment.leaseUntil <= now && !segment.waitpointId && segment.completionStatus === EngineResponseStatus.INTERNAL_ERROR && (!segment.flowRunId || [FlowRunStatus.INTERNAL_ERROR, FlowRunStatus.FAILED].includes(segment.terminalReceipt!))
}
function project(context: Context, input: ChargeResolutionDraftInput) {
    const reservation = context.reservation, inclusive = hostedInclusiveCredits(context.root), rate = inclusive ? context.root.microUsdPerCredit ?? 0n : reservation?.microUsdPerCredit ?? HOSTED_LEGACY_MICRO_USD_PER_CREDIT
    const before = inclusive ? hostedInclusiveExposure({ root: context.root, children: context.reservations }) : null
    const heldCredits = before?.reservedCredits ?? (reservation ? hostedUsesCreditAccounting(reservation.accountingVersion) ? reservation.amount : hostedAiCredits(reservation.amount, rate) : 0n)
    if (input.outcome === 'verified_usage' && context.call.payer === 'managed') {
        const quote = HostedAiQuote.parse(context.call.quote), created = new Date(input.supplierCreatedAt!).getTime(), sent = context.call.sentAt?.getTime()
        if (!sent || sent < new Date(quote.validFrom).getTime() || sent > new Date(quote.validUntil).getTime() || created + 999 < new Date(quote.validFrom).getTime() || created > new Date(quote.validUntil).getTime() || created < sent - 5000 || created > context.now.getTime() + 5000) hostingFail('HOSTING_AI_TARIFF_UNCERTAIN')
    }
    if (input.outcome === 'verified_usage' && (context.call.nativeTool ? input.billable === undefined || !!input.usage : !input.usage || input.billable !== undefined)) hostingFail('HOSTING_CHARGE_RECEIPT_REQUIRED')
    const cost = input.outcome === 'verified_usage' && context.call.payer === 'managed'
        ? context.call.nativeTool ? input.billable ? BigInt(context.call.toolUnitPriceMicroUsd!) : 0n : hostedAiCost({ hit: input.usage!.prompt_cache_hit_tokens, miss: input.usage!.prompt_cache_miss_tokens, output: input.usage!.completion_tokens, prices: HostedAiQuote.parse(context.call.quote).rates })
        : input.outcome !== 'retain' ? 0n : null
    const projectedChildren = before && reservation && input.outcome !== 'retain' ? context.reservations.map(child => child.id === reservation.id ? {
        ...child, state: input.outcome === 'verified_usage' ? 'settled' as const : 'released' as const,
        actualAmount: 0n, actualSupplierMicroUsd: input.outcome === 'verified_usage' ? cost : child.actualSupplierMicroUsd,
    } : child) : context.reservations
    const after = before ? hostedInclusiveExposure({ root: context.root, children: projectedChildren }) : null
    const actualCredits = cost === null ? null : before && after ? after.consumedCredits - before.consumedCredits : hostedAiCredits(cost, rate)
    // For inclusive roots, only the drop in total wallet exposure is released.
    // A reserved-to-consumed transfer is not a refund of available Credits.
    const releasedCredits = input.outcome === 'retain' ? 0n : before && after ? maxZero(before.totalCredits - after.totalCredits) : maxZero(heldCredits - (actualCredits ?? 0n))
    const blockers = rootBlockers(context)
    return { expectedRevision: context.revision, expectedState: hash({ state: context.stateHash, input }), actualMicroUsd: cost?.toString() ?? null, actualCredits: actualCredits?.toString() ?? null, releasedCredits: releasedCredits.toString(), releasedSupplierMicroUsd: input.outcome === 'retain' ? '0' : ((reservation?.supplierMaxMicroUsd ?? reservation?.amount ?? 0n) > (cost ?? 0n) ? (reservation?.supplierMaxMicroUsd ?? reservation?.amount ?? 0n) - (cost ?? 0n) : 0n).toString(), rootWillSettle: input.outcome !== 'retain' && blockers.length === 0 && canResolve(context), blockers, ...(after ? aggregateFields(after) : {}) }

}
async function viewOf(context: Context, actor: HostingActor, userId: string) {
    const reservation = context.reservation, pending = reservation && ['reserved', 'running', 'uncertain'].includes(reservation.state), inclusive = hostedInclusiveCredits(context.root), rate = inclusive ? context.root.microUsdPerCredit ?? 0n : reservation?.microUsdPerCredit ?? HOSTED_LEGACY_MICRO_USD_PER_CREDIT
    const exposure = inclusive ? hostedInclusiveExposure({ root: context.root, children: context.reservations }) : null
    return { nativeTool: context.call.nativeTool ?? null, toolUnitPriceMicroUsd: context.call.toolUnitPriceMicroUsd ?? null, toolTariffVersion: context.call.toolTariffVersion ?? null, identity: identity(actor, userId), callId: context.call.id, platformId: context.call.platformId, projectId: context.call.projectId, callKey: context.call.callKey, attempt: context.call.attempt, requestHash: context.call.requestHash, model: context.call.model, endpoint: context.call.endpoint, sentAt: context.call.sentAt?.toISOString() ?? null, budgetDay: context.call.budgetDay, quote: context.call.quote, rootReservationId: context.root.id, payer: context.call.payer, state: context.call.state, revision: context.revision, stateHash: context.stateHash, heldCredits: exposure ? exposure.reservedCredits.toString() : pending ? (hostedUsesCreditAccounting(reservation.accountingVersion) ? reservation.amount : hostedAiCredits(reservation.amount, rate)).toString() : '0', heldSupplierMicroUsd: pending ? (reservation.supplierMaxMicroUsd ?? reservation.amount).toString() : '0', accountingVersion: inclusive ? context.root.accountingVersion ?? 'legacy-microusd' : reservation?.accountingVersion ?? 'legacy-microusd', microUsdPerCredit: rate.toString(), leaseUntil: context.call.leaseUntil.toISOString(), canResolve: canResolve(context), blockers: rootBlockers(context), ...(exposure ? aggregateFields(exposure) : {}), history: context.history.map(row => ({ id: row.id, revision: row.revision, created: row.created.toISOString(), outcome: row.outcome, reason: row.reason, evidenceReference: row.evidenceReference, supplierRequestId: row.supplierRequestId, operatorIdentityId: row.operatorIdentityId, result: row.result })) }
}
function aggregateFields(exposure: ReturnType<typeof hostedInclusiveExposure>): { creditScope: 'execution_root', rootConsumedCredits: string, rootReservedCredits: string, rootTotalCredits: string } {
    return { creditScope: 'execution_root' as const, rootConsumedCredits: exposure.consumedCredits.toString(), rootReservedCredits: exposure.reservedCredits.toString(), rootTotalCredits: exposure.totalCredits.toString() }
}
function maxZero(value: bigint): bigint {
    return value > 0n ? value : 0n
}

function identity(actor: HostingActor, userId: string) {
    return { userId, identityId: actor.identityId, platformId: actor.platformId, tokenVersion: actor.tokenVersion ?? null } 
}
function json(value: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)) 
}
function hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex') 
}
