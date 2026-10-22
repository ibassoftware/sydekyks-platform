import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { hostedAiCredential } from './hosting-ai-credentials'
import { assertHostedAiPayer, assertHostedAiScope } from './hosting-ai-gateway'
import { HOSTED_AI_TIMEOUT_MS, HOSTED_DEEPSEEK_MODEL, HOSTED_DEEPSEEK_PRO_MODEL, HOSTED_MANAGED_MODEL, HostedAiQuote } from './hosting-ai-policy'
import { createHostedLedger, lockHostedBudget } from './hosting-ledger'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { assertNativeRootBudget, assertNativeWebSearchAllowed } from './hosting-native-policy'
import { deepseekNativeToolProvider, NativeToolInput, NativeToolProvider, NativeToolRequest, NativeToolResult, normalizeNativeToolResult, validatePublicFetchUrl } from './hosting-native-provider'
import { assertPreparedPricing, readApprovedNativeToolPricing } from './hosting-pricing'
import { HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

type Scope = { admissionId: string, platformId: string, projectId: string }

export function createHostedNativeTools({ dataSource, provider = deepseekNativeToolProvider, validateUrl = validatePublicFetchUrl }: { dataSource: DataSource, provider?: NativeToolProvider, validateUrl?: (url: string) => Promise<string> }) {
    async function execute({ scope, request, signal }: { scope: Scope, request: NativeToolInput, signal?: AbortSignal }): Promise<NativeToolResult> {
        const input = NativeToolRequest.parse(request)
        if (input.model !== (input.payer.type === 'managed' ? HOSTED_MANAGED_MODEL : HOSTED_DEEPSEEK_MODEL)) hostingFail('HOSTING_AI_MODEL_DENIED')
        if (input.kind === 'fetch') input.url = await validateUrl(input.url!)
        const prepared = await tx.run({ dataSource, fn: async manager => {
            const day = (await tx.now(manager)).toISOString().slice(0, 10)
            if (input.payer.type === 'managed') await lockHostedBudget({ manager, day, create: true })
            await tx.account({ manager, platformId: scope.platformId })
            const { segment, root } = await assertHostedAiScope({ manager, scope })
            await assertHostedAiPayer({ manager, scope, input, segment, root, nativeTool: true })
            await assertNativeWebSearchAllowed(manager, segment, input)
            const credential = await hostedAiCredential({ manager, ...scope, payer: input.payer, model: input.model })
            const resolvedModel = input.payer.type === 'managed' ? credential.model : HOSTED_DEEPSEEK_MODEL
            if (resolvedModel !== HOSTED_DEEPSEEK_MODEL && resolvedModel !== HOSTED_DEEPSEEK_PRO_MODEL) hostingFail('HOSTING_AI_MODEL_DENIED')
            const pricing = await readApprovedNativeToolPricing(manager, await tx.now(manager), resolvedModel, input.kind)
            const endpoint = `https://api.deepseek.com/v1/tools/${input.kind}`
            const tariffVersion = `${pricing.tariffVersion}:${pricing.quote.version}`
            const requestHash = hash({ endpoint, kind: input.kind, stepName: input.stepName ?? null, payer: input.payer, query: input.query ?? null, url: input.url ?? null })
            const prior = await manager.getRepository(HostingModelCallEntity).findOneBy({ segmentId: segment.id, callKey: input.callKey, attempt: 0 })
            if (prior) {
                if (prior.requestHash !== requestHash || prior.credentialFingerprint !== credential.fingerprint || prior.admissionId !== scope.admissionId || prior.nativeTool !== input.kind) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return prior
            }
            const siblings = await manager.getRepository(HostingModelCallEntity).findBy({ platformId: scope.platformId, rootReservationId: root.id })
            if (siblings.some(call => call.state === 'uncertain')) hostingFail('HOSTING_AI_OUTCOME_UNCERTAIN')
            if (siblings.some(call => ['prepared', 'running'].includes(call.state))) hostingFail('HOSTING_AI_CONCURRENCY_LIMIT')
            if (siblings.filter(call => call.nativeTool === input.kind).length >= (input.kind === 'search' ? 2 : 3)) hostingFail('HOSTING_NATIVE_TOOL_LIMIT')
            if (siblings.length >= 32) hostingFail('HOSTING_AI_CALL_LIMIT')
            await assertNativeRootBudget({ manager, platformId: scope.platformId, rootId: root.id, maxCostMicroUsd: input.payer.type === 'managed' ? pricing.unitPriceMicroUsd : 0n, native: true })
            const id = apId(), reservation = input.payer.type === 'managed' ? await createHostedLedger({ dataSource, manager }).reserveManagedCall({ actor: actor(segment), rootReservationId: root.id, key: `native:${id}`, maxCostMicroUsd: pricing.unitPriceMicroUsd, expectedDay: day }) : null
            const now = await tx.now(manager)
            return manager.getRepository(HostingModelCallEntity).save({ id, platformId: scope.platformId, projectId: scope.projectId, segmentId: segment.id, rootReservationId: root.id, admissionId: scope.admissionId, identityId: segment.identityId, callKey: input.callKey, attempt: 0, requestHash, payer: input.payer.type, configId: input.payer.type === 'byok' ? input.payer.configId : null, credentialFingerprint: credential.fingerprint, model: resolvedModel, endpoint, state: 'prepared', reservationId: reservation?.id ?? null, dispatchId: null, fence: null, budgetDay: reservation?.day ?? null, quote: input.payer.type === 'managed' ? pricing.quote : null, inputTokenBound: null, response: null, usage: null, actualMicroUsd: null, sentAt: null, nativeTool: input.kind, nativeFeature: true, toolUnitPriceMicroUsd: pricing.unitPriceMicroUsd.toString(), toolTariffVersion: tariffVersion, leaseUntil: new Date(now.getTime() + HOSTED_AI_TIMEOUT_MS + 5000) })
        } })
        if (prepared.state === 'settled' && prepared.response) return prepared.response as NativeToolResult
        if (prepared.state !== 'prepared') hostingFail('HOSTING_AI_OUTCOME_UNAVAILABLE')
        const claim = await tx.run({ dataSource, fn: async manager => {
            if (prepared.budgetDay) await lockHostedBudget({ manager, day: prepared.budgetDay, create: false })
            await tx.account({ manager, platformId: scope.platformId })
            const call = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: prepared.id })
            if (call.state !== 'prepared') return { denied: 'HOSTING_AI_OUTCOME_UNAVAILABLE' }
            try {
                if (signal?.aborted) hostingFail('HOSTING_AI_CANCELLED_UNSENT')
                const { segment, root } = await assertHostedAiScope({ manager, scope })
                if (call.segmentId !== segment.id || call.leaseUntil <= await tx.now(manager)) hostingFail('HOSTING_AI_ADMISSION_EXPIRED')
                await assertHostedAiPayer({ manager, scope, input, segment, root, nativeTool: true })
                await assertNativeWebSearchAllowed(manager, segment, input)
                const credential = await hostedAiCredential({ manager, ...scope, payer: input.payer, model: input.model })
                if (credential.fingerprint !== call.credentialFingerprint) hostingFail('HOSTING_AI_CREDENTIAL_CHANGED')
                const resolvedModel = input.payer.type === 'managed' ? credential.model : HOSTED_DEEPSEEK_MODEL
                if (resolvedModel !== HOSTED_DEEPSEEK_MODEL && resolvedModel !== HOSTED_DEEPSEEK_PRO_MODEL) hostingFail('HOSTING_AI_MODEL_DENIED')
                const pricing = await readApprovedNativeToolPricing(manager, await tx.now(manager), resolvedModel, input.kind)
                if (call.toolTariffVersion !== `${pricing.tariffVersion}:${pricing.quote.version}` || call.toolUnitPriceMicroUsd !== pricing.unitPriceMicroUsd.toString()) hostingFail('HOSTING_AI_PRICE_CHANGED')
                if (call.quote) await assertPreparedPricing(manager, HostedAiQuote.parse(call.quote), await tx.now(manager))
                const ledgerClaim = call.reservationId ? await createHostedLedger({ dataSource, manager }).claimManagedCall({ actor: actor(segment), reservationId: call.reservationId }) : null
                if (ledgerClaim && !ledgerClaim.claimed) hostingFail('HOSTING_AI_ADMISSION_EXPIRED')
                const fence = apId(), sentAt = await tx.now(manager)
                await manager.getRepository(HostingModelCallEntity).update({ id: call.id }, { state: 'running', fence, dispatchId: ledgerClaim?.dispatchId ?? null, sentAt, leaseUntil: new Date(sentAt.getTime() + HOSTED_AI_TIMEOUT_MS + 5000) })
                return { fence, apiKey: credential.apiKey }
            }
            catch (error) {
                if (!(error instanceof HostingError)) throw error
                if (call.reservationId) await createHostedLedger({ dataSource, manager }).cancelUnsent({ platformId: call.platformId, reservationId: call.reservationId })
                await manager.getRepository(HostingModelCallEntity).update({ id: call.id }, { state: 'cancelled' })
                return { denied: error.message }
            }
        } })
        if (claim.denied || !claim.apiKey || !claim.fence) hostingFail(claim.denied ?? 'HOSTING_AI_OUTCOME_UNAVAILABLE')
        try {
            const response = await provider.execute({ request: input, apiKey: claim.apiKey, signal })
            const outcome = normalizeNativeToolResult(input, response.status, response.data)
            await tx.run({ dataSource, fn: async manager => {
                if (prepared.budgetDay) await lockHostedBudget({ manager, day: prepared.budgetDay, create: false })
                await tx.account({ manager, platformId: scope.platformId })
                const call = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: prepared.id })
                if (call.fence !== claim.fence || !['running', 'uncertain'].includes(call.state)) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
                const cost = outcome.billable ? BigInt(call.toolUnitPriceMicroUsd!) : 0n
                if (call.reservationId) await createHostedLedger({ dataSource, manager }).settleManagedCall({ platformId: call.platformId, reservationId: call.reservationId, dispatchId: call.dispatchId!, actualCostMicroUsd: cost })
                await manager.getRepository(HostingModelCallEntity).update({ id: call.id }, { state: 'settled', response: outcome.result as never, usage: { successful_requests: outcome.billable ? 1 : 0 }, actualMicroUsd: call.payer === 'managed' ? cost.toString() : null })
                await tx.event({ manager, platformId: call.platformId, event: 'native_tool.settled', payload: { callId: call.id, kind: call.nativeTool, payer: call.payer, billable: outcome.billable, actualMicroUsd: call.payer === 'managed' ? cost.toString() : null } })
            } })
            return outcome.result
        }
        catch {
            await tx.run({ dataSource, fn: async manager => {
                await tx.account({ manager, platformId: scope.platformId })
                const call = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: prepared.id })
                if (call.state === 'settled' || call.state === 'uncertain') return
                if (call.state !== 'running' || call.fence !== claim.fence) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
                if (call.reservationId) await createHostedLedger({ dataSource, manager }).markUncertain({ platformId: call.platformId, reservationId: call.reservationId, dispatchId: call.dispatchId! })
                await manager.getRepository(HostingModelCallEntity).update({ id: call.id }, { state: 'uncertain' })
            } })
            hostingFail('HOSTING_AI_OUTCOME_UNCERTAIN')
        }
    }
    return { execute }
}

function actor(segment: { identityId: string, platformId: string, tokenVersion?: string | null, originType?: string }) {
    return { identityId: segment.identityId, platformId: segment.platformId, ...(segment.originType === 'user' ? { tokenVersion: segment.tokenVersion } : {}) }
}
function hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
