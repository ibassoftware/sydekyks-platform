import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { AIProviderName, apId } from '@activepieces/core-utils'
import { AgentConversationStatus, AgentRunSource, WorkerJobType } from '@activepieces/shared'
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm'
import { z } from 'zod'
import { sydApprovalGate } from '../syd/copilot/approval-gate'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { hostedAiCredential } from './hosting-ai-credentials'
import { HOSTED_AI_CONTEXT_TOKENS, HOSTED_AI_MAX_CALLS, HOSTED_AI_TIMEOUT_MS, HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL, hostedAiCost, HostedAiInput, HostedAiQuote, HostedAiRequest, readHostedAiQuote } from './hosting-ai-policy'
import { deepseekHostedProvider, HostedAiProvider, hostedModelCatalog } from './hosting-ai-provider'
import { createHostedStreamParser, settledCompletionStream } from './hosting-ai-stream'
import { HostingDispatch, HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingReservationEntity } from './hosting-entities'
import { createHostedLedger, lockHostedBudget } from './hosting-ledger'
import { HostingModelCall, HostingModelCallEntity } from './hosting-model-call-entity'
import { HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const number = z.number().int().min(0).max(10_000_000)
const usageSchema = z.object({ prompt_tokens: number, completion_tokens: number, total_tokens: number, prompt_cache_hit_tokens: number, prompt_cache_miss_tokens: number })
const completionSchema = z.object({ id: z.string().max(256), model: z.string().max(128), created: z.number().int(), object: z.literal('chat.completion'), choices: z.array(z.object({ index: z.literal(0), finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']), message: z.object({ role: z.literal('assistant'), content: z.string().nullable(), tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }) })).length(1), usage: usageSchema })
type Scope = { admissionId: string, platformId: string, projectId: string }

export function createHostedAiGateway({ dataSource, provider = deepseekHostedProvider }: { dataSource: DataSource, provider?: HostedAiProvider }) {
    async function dispatch({ scope, request, stream = false, signal }: { scope: Scope, request: HostedAiInput, stream?: boolean, signal?: AbortSignal }): Promise<Record<string, unknown> | Readable> {
        const submitted = HostedAiRequest.parse(request)
        if (submitted.model !== (submitted.payer.type === 'managed' ? HOSTED_MANAGED_MODEL : HOSTED_DEEPSEEK_MODEL)) hostingFail('HOSTING_AI_MODEL_DENIED')
        const input = { ...submitted, model: submitted.payer.type === 'managed' ? readHostedAiQuote(new Date()).model : HOSTED_DEEPSEEK_MODEL }
        if (Buffer.byteLength(JSON.stringify(input)) > 65536) hostingFail('HOSTING_AI_REQUEST_LIMIT')
        const hash = digest({ provider: provider.id, endpoint: provider.endpoint, accountingVersion: hostedModelCatalog[input.model].accountingVersion, payer: input.payer, model: input.model, messages: input.messages, max_tokens: input.max_tokens, temperature: input.temperature, response_format: input.response_format, tools: input.tools, tool_choice: input.tool_choice })
        const prepared = await tx.run({ dataSource, fn: async manager => {
            const day = (await tx.now(manager)).toISOString().slice(0, 10)
            if (input.payer.type === 'managed') await lockHostedBudget({ manager, day, create: true })
            const account = await tx.account({ manager, platformId: scope.platformId })
            if (!hostedModelCatalog[input.model].allowedPlans.includes(account.planId)) hostingFail('HOSTING_AI_MODEL_PLAN_DENIED')
            const { segment, root } = await current({ manager, scope })
            if (root.payer !== input.payer.type) hostingFail('HOSTING_AI_PAYER_CONFLICT')
            if (segment.payload?.jobType === WorkerJobType.EXECUTE_AGENT_RUN) {
                const job = segment.payload
                const byok = job.provider === AIProviderName.DEEPSEEK
                if (input.attempt !== 0 || !/^copilot:[0-9]+$/.test(input.callKey) || (byok ? input.payer.type !== 'byok' || input.payer.configId !== job.providerConfigId : input.payer.type !== 'managed')) hostingFail('HOSTING_AI_PAYER_CONFLICT')
                if (await manager.getRepository(HostingModelCallEntity).existsBy({ rootReservationId: root.id, state: 'uncertain' })) hostingFail('HOSTING_AI_OUTCOME_UNCERTAIN')
            }
            const credential = await hostedAiCredential({ manager, ...scope, payer: input.payer, model: input.model })
            const existing = await manager.getRepository(HostingModelCallEntity).findOneBy({ segmentId: segment.id, callKey: input.callKey, attempt: input.attempt })
            if (existing) {
                if (existing.requestHash !== hash || existing.credentialFingerprint !== credential.fingerprint || existing.admissionId !== scope.admissionId) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return existing
            }
            const previous = await manager.getRepository(HostingModelCallEntity).findOne({ where: { segmentId: segment.id, callKey: input.callKey }, order: { attempt: 'DESC' } })
            if ((input.attempt === 0 && previous) || (input.attempt > 0 && (!previous || previous.attempt + 1 !== input.attempt || previous.requestHash !== hash || previous.credentialFingerprint !== credential.fingerprint || !['cancelled', 'uncertain'].includes(previous.state)))) hostingFail('HOSTING_AI_RETRY_DENIED')
            if (await manager.getRepository(HostingModelCallEntity).countBy({ platformId: scope.platformId, rootReservationId: root.id }) >= HOSTED_AI_MAX_CALLS) hostingFail('HOSTING_AI_CALL_LIMIT')
            if (await manager.getRepository(HostingModelCallEntity).existsBy({ platformId: scope.platformId, rootReservationId: root.id, state: In(['prepared', 'running']) })) hostingFail('HOSTING_AI_CONCURRENCY_LIMIT')
            const now = await tx.now(manager)
            const quote = input.payer.type === 'managed' ? readHostedAiQuote(now) : null
            if (quote && quote.model !== input.model) hostingFail('HOSTING_AI_PRICE_CHANGED')
            const capabilities = hostedModelCatalog[input.model].capabilities
            if ((input.tools?.length && !capabilities.tools) || (input.response_format?.type === 'json_object' && !capabilities.json) || (stream && !capabilities.stream)) hostingFail('HOSTING_AI_CAPABILITY_DENIED')
            const id = apId()
            const reservation = quote ? await createHostedLedger({ dataSource, manager }).reserveManagedCall({ actor: actorOf(segment), rootReservationId: root.id, key: `model:${id}`, maxCostMicroUsd: hostedAiCost({ hit: 0, miss: HOSTED_AI_CONTEXT_TOKENS, output: input.max_tokens, prices: quote.ceiling }), expectedDay: day }) : null
            return manager.getRepository(HostingModelCallEntity).save(manager.getRepository(HostingModelCallEntity).create({ id, platformId: scope.platformId, projectId: scope.projectId, segmentId: segment.id, rootReservationId: root.id, admissionId: scope.admissionId, identityId: segment.identityId, callKey: input.callKey, attempt: input.attempt, requestHash: hash, payer: input.payer.type, configId: input.payer.type === 'byok' ? input.payer.configId : null, credentialFingerprint: credential.fingerprint, model: input.model, endpoint: provider.endpoint, state: 'prepared', reservationId: reservation?.id ?? null, budgetDay: reservation?.day ?? null, quote, leaseUntil: new Date(now.getTime() + HOSTED_AI_TIMEOUT_MS + 5000) }))
        } })
        if (prepared.state === 'settled' && prepared.response) return stream ? Readable.from(settledCompletionStream(publicResponse(prepared.response, prepared))) : publicResponse(prepared.response, prepared)
        if (prepared.state !== 'prepared') hostingFail('HOSTING_AI_OUTCOME_UNAVAILABLE')
        const claim = await tx.run({ dataSource, fn: async manager => {
            await lockCallBudget({ manager, call: prepared })
            await tx.account({ manager, platformId: prepared.platformId })
            const call = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: prepared.id })
            if (call.state !== 'prepared') return { denied: 'HOSTING_AI_OUTCOME_UNAVAILABLE' }
            try {
                if (signal?.aborted) hostingFail('HOSTING_AI_CANCELLED_UNSENT')
                const { segment } = await current({ manager, scope })
                if (segment.id !== call.segmentId || call.leaseUntil <= await tx.now(manager)) hostingFail('HOSTING_AI_ADMISSION_EXPIRED')
                const credential = await hostedAiCredential({ manager, ...scope, payer: input.payer, model: input.model })
                if (credential.fingerprint !== call.credentialFingerprint) hostingFail('HOSTING_AI_CREDENTIAL_CHANGED')
                if (call.quote && digest(readHostedAiQuote(await tx.now(manager))) !== digest(call.quote)) hostingFail('HOSTING_AI_PRICE_CHANGED')
                const ledgerClaim = call.reservationId ? await createHostedLedger({ dataSource, manager }).claimManagedCall({ actor: actorOf(segment), reservationId: call.reservationId }) : null
                if (ledgerClaim && !ledgerClaim.claimed) hostingFail('HOSTING_AI_ADMISSION_EXPIRED')
                const fence = apId()
                const sentAt = await tx.now(manager)
                await manager.getRepository(HostingModelCallEntity).save({ ...call, state: 'running', fence, dispatchId: ledgerClaim?.dispatchId ?? null, sentAt, leaseUntil: new Date(sentAt.getTime() + HOSTED_AI_TIMEOUT_MS + 5000) })
                return { apiKey: credential.apiKey, fence }
            }
            catch (error) {
                if (!(error instanceof HostingError)) throw error
                await cancelPrepared({ manager, call })
                return { denied: error.message }
            }
        } })
        if (claim.denied || !claim.apiKey || !claim.fence) hostingFail(claim.denied ?? 'HOSTING_AI_OUTCOME_UNAVAILABLE')
        try {
            const response = await provider.complete({ request: input, apiKey: claim.apiKey, stream, signal })
            if (response.status !== 200) {
                if (stream && response.data instanceof Readable) response.data.destroy()
                hostingFail('HOSTING_AI_PROVIDER_OUTCOME_UNKNOWN')
            }
            if (stream) {
                const upstream = response.data as Readable
                return Readable.from((async function* () {
                    let settled = false
                    try {
                        const parser = createHostedStreamParser(input.model)
                        const decoder = new StringDecoder('utf8')
                        for await (const bytes of upstream) {
                            for (const text of parser.push(decoder.write(Buffer.from(bytes)))) yield publicChunk(text, prepared)
                        }
                        for (const text of parser.push(decoder.end())) yield publicChunk(text, prepared)
                        const completion = completionSchema.parse(parser.finish())
                        validateUsage(completion.usage)
                        const saved = await settle({ callId: prepared.id, fence: claim.fence!, response: completion, maxOutput: input.max_tokens })
                        settled = true
                        for (const text of settledCompletionStream(publicResponse(saved, prepared), true)) yield publicChunk(text, prepared)
                    }
                    catch {
                        throw new HostingError('HOSTING_AI_OUTCOME_UNCERTAIN')
                    }
                    finally {
                        upstream.destroy()
                        if (!settled) await markUncertain({ callId: prepared.id, fence: claim.fence! })
                    }
                })())
            }
            const parsed = completionSchema.safeParse(response.data)
            if (!parsed.success || parsed.data.model !== input.model) hostingFail('HOSTING_AI_USAGE_UNVERIFIED')
            const usage = parsed.data.usage
            validateUsage(usage)
            return publicResponse(await settle({ callId: prepared.id, fence: claim.fence, response: parsed.data, maxOutput: input.max_tokens }), prepared)
        }
        catch {
            await markUncertain({ callId: prepared.id, fence: claim.fence })
            hostingFail('HOSTING_AI_OUTCOME_UNCERTAIN')
        }
    }

    async function settle({ callId, fence, response, maxOutput }: { callId: string, fence: string, response: z.infer<typeof completionSchema>, maxOutput: number }): Promise<Record<string, unknown>> {
        const peek = await dataSource.getRepository(HostingModelCallEntity).findOneByOrFail({ id: callId })
        return tx.run({ dataSource, fn: async manager => {
            await lockCallBudget({ manager, call: peek })
            await tx.account({ manager, platformId: peek.platformId })
            const call = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: callId })
            if (call.fence !== fence) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            if (call.state === 'settled' && call.response) return call.response
            if (!['running', 'uncertain'].includes(call.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            const now = await tx.now(manager)
            let cost: bigint | null = null
            if (call.quote) {
                const quote = HostedAiQuote.parse(call.quote)
                const createdAt = response.created * 1000
                if (!call.sentAt || call.sentAt < new Date(quote.validFrom) || now > new Date(quote.validUntil) || createdAt < new Date(quote.validFrom).getTime() || createdAt > new Date(quote.validUntil).getTime() || createdAt < call.sentAt.getTime() - 5000 || createdAt > now.getTime() + 5000) hostingFail('HOSTING_AI_TARIFF_UNCERTAIN')
                cost = hostedAiCost({ hit: response.usage.prompt_cache_hit_tokens, miss: response.usage.prompt_cache_miss_tokens, output: response.usage.completion_tokens, prices: quote.rates })
                await createHostedLedger({ dataSource, manager }).settleManagedCall({ platformId: call.platformId, reservationId: required(call.reservationId), dispatchId: required(call.dispatchId), actualCostMicroUsd: cost })
            }
            if (response.usage.prompt_tokens > HOSTED_AI_CONTEXT_TOKENS || response.usage.completion_tokens > maxOutput) await manager.getRepository(HostingAccountEntity).update({ id: call.platformId }, { status: 'suspended' })
            await manager.getRepository(HostingModelCallEntity).save({ ...call, state: 'settled', response, usage: response.usage, actualMicroUsd: cost?.toString() ?? null })
            await tx.event({ manager, platformId: call.platformId, event: 'model_call.settled', payload: { callId, payer: call.payer, actualMicroUsd: cost?.toString() ?? null } })
            return response
        } })
    }

    async function markUncertain({ callId, fence }: { callId: string, fence: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            const peek = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: callId })
            await tx.account({ manager, platformId: peek.platformId })
            const call = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: callId })
            if (call.state === 'settled' || call.state === 'uncertain') return
            if (call.state !== 'running' || call.fence !== fence) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
            if (call.reservationId) await createHostedLedger({ dataSource, manager }).markUncertain({ platformId: call.platformId, reservationId: call.reservationId, dispatchId: required(call.dispatchId) })
            await manager.getRepository(HostingModelCallEntity).update({ id: call.id }, { state: 'uncertain' })
            await tx.event({ manager, platformId: call.platformId, event: 'model_call.uncertain', payload: { callId, payer: call.payer } })
        } })
    }

    async function recover(): Promise<void> {
        const now = new Date()
        const calls = await dataSource.getRepository(HostingModelCallEntity).find({ where: { state: In(['prepared', 'running']), leaseUntil: LessThanOrEqual(now) }, take: 50, order: { leaseUntil: 'ASC', id: 'ASC' } })
        for (const call of calls) {
            if (call.state === 'running') {
                await markUncertain({ callId: call.id, fence: required(call.fence) }); continue
            }
            await tx.run({ dataSource, fn: async manager => {
                await lockCallBudget({ manager, call })
                await tx.account({ manager, platformId: call.platformId })
                const current = await manager.getRepository(HostingModelCallEntity).findOneByOrFail({ id: call.id })
                if (current.state === 'prepared' && current.leaseUntil <= await tx.now(manager)) await cancelPrepared({ manager, call: current })
            } })
        }
    }

    async function cancelPrepared({ manager, call }: { manager: EntityManager, call: HostingModelCall }): Promise<void> {
        if (call.reservationId) {
            const reservation = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: call.reservationId, platformId: call.platformId })
            if (reservation.state === 'reserved') await createHostedLedger({ dataSource, manager }).cancelUnsent({ platformId: call.platformId, reservationId: reservation.id })
        }
        await manager.getRepository(HostingModelCallEntity).update({ id: call.id }, { state: 'cancelled' })
    }

    return { execute: (args: { scope: Scope, request: HostedAiInput, signal?: AbortSignal }) => dispatch(args) as Promise<Record<string, unknown>>, stream: (args: { scope: Scope, request: HostedAiInput, signal?: AbortSignal }) => dispatch({ ...args, stream: true }) as Promise<Readable>, recover }
}

async function current({ manager, scope }: { manager: EntityManager, scope: Scope }) {
    const segment = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId: scope.admissionId, platformId: scope.platformId, projectId: scope.projectId, state: 'running' })
    const now = await tx.now(manager)
    if (!segment || segment.terminalReceipt || !segment.leaseUntil || segment.leaseUntil <= now) hostingFail('HOSTING_AI_SEGMENT_DENIED')
    if (segment.payload?.jobType === WorkerJobType.EXECUTE_AGENT_RUN) {
        const data = segment.payload
        const conversation = await manager.getRepository(SydConversationEntity).findOneBy({ id: data.conversationId, platformId: scope.platformId, userId: data.userId, source: AgentRunSource.CHAT, activeRunId: data.runId })
        if (!conversation || conversation.status !== AgentConversationStatus.STREAMING || await sydApprovalGate.isCancelled({ conversationId: data.conversationId, runId: data.runId }) || (conversation.projectId && conversation.projectId !== scope.projectId)) hostingFail('HOSTING_AI_SEGMENT_DENIED')
    }
    if (segment.flowRunId) {
        const latest = await manager.getRepository(HostingDispatchEntity).findOne({ where: { platformId: scope.platformId, flowRunId: segment.flowRunId }, order: { generation: 'DESC' } })
        if (latest?.id !== segment.id) hostingFail('HOSTING_AI_SEGMENT_DENIED')
    }
    await tx.member({ manager, actor: actorOf(segment), projectId: scope.projectId, write: true })
    const account = await tx.account({ manager, platformId: scope.platformId })
    tx.assertActive({ account, now })
    const root = await manager.getRepository(HostingReservationEntity).findOneBy({ id: required(segment.reservationId), platformId: scope.platformId, kind: 'execution', state: 'running' })
    if (!root || root.identityId !== segment.identityId || root.projectId !== scope.projectId) hostingFail('HOSTING_AI_ROOT_DENIED')
    const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId, platformId: root.platformId })
    tx.assertGrantActive({ grant, now })
    return { segment, root }
}
async function lockCallBudget({ manager, call }: { manager: EntityManager, call: HostingModelCall }): Promise<void> {
    if (call.budgetDay) await lockHostedBudget({ manager, day: call.budgetDay, create: false })
}
function actorOf(segment: HostingDispatch) {
    return { identityId: segment.identityId, platformId: segment.platformId, ...(segment.originType === 'user' ? { tokenVersion: segment.tokenVersion } : {}) }
}
function required(value: string | null): string {
    if (!value) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH'); return value
}
function digest(value: unknown): string {
    return createHash('sha256').update(canonical(JSON.parse(JSON.stringify(value)))).digest('hex')
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

function validateUsage(usage: z.infer<typeof usageSchema>): void {
    if (usage.prompt_tokens !== usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) hostingFail('HOSTING_AI_USAGE_UNVERIFIED')
}

function publicResponse(response: Record<string, unknown>, call: Pick<HostingModelCall, 'id' | 'payer'>): Record<string, unknown> {
    return call.payer === 'managed' ? { ...response, id: `sydekyks-${call.id}`, model: HOSTED_MANAGED_MODEL } : response
}
function publicChunk(text: string, call: Pick<HostingModelCall, 'id' | 'payer'>): string {
    if (call.payer !== 'managed' || text.trim() === 'data: [DONE]') return text
    return `data: ${JSON.stringify(publicResponse(JSON.parse(text.slice(6).trim()), call))}\n\n`
}
