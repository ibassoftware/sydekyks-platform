import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { HOSTED_MICRO_USD_PER_CREDIT, HostedPlanId, hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager, IsNull, LessThanOrEqual, MoreThan } from 'typeorm'
import { z } from 'zod'
import { assertHostingOperator } from './hosting-access-policy'
import { AllowanceGrantSnapshot, HostingAiAllowanceBindingEntity, HostingAiAllowanceChangeEntity } from './hosting-ai-allowance-entities'
import { HostingAccount, HostingGrant, HostingGrantEntity, HostingLedgerEntity } from './hosting-entities'
import { hostingGrantMatchesPlan } from './hosting-plan-grants'
import { HostingStripePeriodEntity } from './hosting-stripe-entities'
import { HostingTrainingEntity } from './hosting-training-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const HostingAiAllowanceInput = z.strictObject({
    platformId: z.string().length(21), expectedRevision: z.number().int().nonnegative().max(1000),
    requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), monthlyCredits: z.number().int().min(0).max(1_000_000).nullable(), reason: z.string().trim().max(500).default(''),
})
export type HostingAiAllowanceInput = z.input<typeof HostingAiAllowanceInput>

// Callers creating a grant hold the same account write lock used by allowance saves.
// The supplied plan is the grant's own source period, not the account's current plan.
export async function effectiveManagedAiCredits(manager: EntityManager, platformId: string, planId: HostedPlanId): Promise<number> {
    if (planId === 'trial' || planId === 'assessment') return hostingCatalog.getPlan({ planId }).aiCredits
    const { change } = await currentPolicy(manager, platformId)
    return change?.monthlyCredits ?? hostingCatalog.getPlan({ planId }).aiCredits
}

export function createHostedAiAllowance({ dataSource }: { dataSource: DataSource }) {
    async function read({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            const user = await assertHostingOperator({ manager, actor })
            const account = await tx.account({ manager, platformId })
            await assertHostingOperator({ manager, actor })
            return { ...await allowanceView(manager, account, await tx.now(manager)), platformId: actor.platformId, userId: user.id }
        } })
    }
    async function save({ actor, input }: { actor: HostingActor, input: HostingAiAllowanceInput }) {
        const value = HostingAiAllowanceInput.parse(input), payloadHash = digest(value)
        try {
            return await tx.run({ dataSource, fn: async manager => {
                const user = await assertHostingOperator({ manager, actor })
                // Ledger reservation, settlement, refunds and new grant issuance all
                // serialize on this account. Never acquire the daily budget here.
                const account = await tx.account({ manager, platformId: value.platformId })
                await assertHostingOperator({ manager, actor })
                if (account.planId === 'assessment') hostingFail('HOSTING_ASSESSMENT_ALLOWANCE_FIXED')
                const now = await tx.now(manager), { binding, change: previous } = await currentPolicy(manager, account.id)
                const prior = await manager.getRepository(HostingAiAllowanceChangeEntity).findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
                if (prior) {
                    if (prior.payloadHash !== payloadHash) hostingFail('HOSTING_AI_ALLOWANCE_IDEMPOTENCY_CONFLICT')
                    return { ...await allowanceView(manager, account, now), platformId: actor.platformId, userId: user.id }
                }
                if ((binding?.revision ?? 0) !== value.expectedRevision) hostingFail('HOSTING_AI_ALLOWANCE_REVISION_CONFLICT')
                if ((binding?.revision ?? 0) >= 1000) hostingFail('HOSTING_AI_ALLOWANCE_HISTORY_LIMIT')
                const candidates = account.validUntil > now ? await manager.getRepository(HostingGrantEntity).find({
                    where: { platformId: account.id, meter: 'managed_ai', revokedAt: IsNull(), validUntil: MoreThan(now) }, order: { validFrom: 'ASC', id: 'ASC' }, take: 257,
                }) : []
                if (candidates.length > 256) hostingFail('HOSTING_AI_ALLOWANCE_GRANT_LIMIT')
                const updates: { grant: HostingGrant, planId: HostedPlanId, amount: bigint }[] = []
                for (const grant of candidates) {
                    const planId = await sourcePlan(manager, account, grant)
                    if (!planId) continue // A trial is a one-off $1 grant; never amend it.
                    updates.push({ grant, planId, amount: BigInt(value.monthlyCredits ?? hostingCatalog.getPlan({ planId }).aiCredits) * HOSTED_MICRO_USD_PER_CREDIT })
                }
                const snapshots: AllowanceGrantSnapshot[] = updates.map(({ grant, planId, amount }) => ({
                    grantId: grant.id, sourceKey: grant.sourceKey, planId, validFrom: grant.validFrom.toISOString(), validUntil: grant.validUntil.toISOString(),
                    previousAmountMicroUsd: grant.amount.toString(), amountMicroUsd: amount.toString(), consumedMicroUsd: grant.consumed.toString(), reservedMicroUsd: grant.reserved.toString(),
                }))
                const change = await manager.getRepository(HostingAiAllowanceChangeEntity).save({ id: apId(), platformId: account.id, revision: (binding?.revision ?? 0) + 1, operatorIdentityId: actor.identityId, requestKey: value.requestKey, payloadHash, monthlyCredits: value.monthlyCredits, previousMonthlyCredits: previous?.monthlyCredits ?? null, reason: value.reason, grantSnapshots: snapshots })
                for (const { grant, amount } of updates) {
                    if (amount === grant.amount) continue
                    await manager.getRepository(HostingGrantEntity).update({ id: grant.id, platformId: account.id }, { amount })
                    const delta = amount - grant.amount
                    await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId: grant.id, reservationId: null, operation: delta > 0n ? 'grant' : 'revoke', key: `allowance:${change.id}:${grant.id}`, amount: delta > 0n ? delta : -delta })
                }
                await manager.getRepository(HostingAiAllowanceBindingEntity).save({ id: binding?.id ?? apId(), platformId: account.id, revision: change.revision, changeId: change.id })
                await tx.event({ manager, platformId: account.id, event: 'managed_ai.allowance_changed', payload: { changeId: change.id, revision: change.revision, monthlyCredits: value.monthlyCredits, previousMonthlyCredits: previous?.monthlyCredits ?? null, operatorIdentityId: actor.identityId, adjustedGrants: snapshots.length } })
                return { ...await allowanceView(manager, account, now), platformId: actor.platformId, userId: user.id }
            } })
        }
        catch (error) {
            if (isRequestCollision(error)) hostingFail('HOSTING_AI_ALLOWANCE_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    return { read, save }
}

async function currentPolicy(manager: EntityManager, platformId: string) {
    const binding = await manager.getRepository(HostingAiAllowanceBindingEntity).findOneBy({ platformId })
    const change = binding ? await manager.getRepository(HostingAiAllowanceChangeEntity).findOneBy({ id: binding.changeId, platformId, revision: binding.revision }) : null
    if (binding && !change) hostingFail('HOSTING_AI_ALLOWANCE_POLICY_INVALID')
    return { binding, change }
}
async function allowanceView(manager: EntityManager, account: HostingAccount, now: Date) {
    const { binding, change } = await currentPolicy(manager, account.id)
    const defaultMonthlyCredits = hostingCatalog.getPlan({ planId: account.planId === 'trial' ? 'training' : account.planId }).aiCredits
    const grants = await manager.getRepository(HostingGrantEntity).find({ where: { platformId: account.id, meter: 'managed_ai', validFrom: LessThanOrEqual(now), validUntil: MoreThan(now), revokedAt: IsNull() }, order: { validFrom: 'DESC', id: 'ASC' }, take: 257 })
    if (grants.length > 256) hostingFail('HOSTING_AI_ALLOWANCE_GRANT_LIMIT')
    const current = grants.find(grant => hostingGrantMatchesPlan(grant, account.planId) && grant.validFrom <= now && grant.validUntil > now && !grant.revokedAt)
    const remaining = current ? current.amount - current.consumed - current.reserved : 0n
    const active = account.status !== 'suspended' && !account.billingHold && account.validUntil > now
    return {
        scopePlatformId: account.id, revision: binding?.revision ?? 0, planId: account.planId, overrideMonthlyCredits: change?.monthlyCredits ?? null, defaultMonthlyCredits,
        effectiveMonthlyCredits: account.planId === 'assessment' ? defaultMonthlyCredits : change?.monthlyCredits ?? defaultMonthlyCredits, appliesToCurrentPeriod: account.planId !== 'trial' && account.planId !== 'assessment' && !!current && account.validUntil > now,
        period: current ? { validFrom: current.validFrom.toISOString(), validUntil: current.validUntil.toISOString(), amountMicroUsd: current.amount.toString(), consumedMicroUsd: current.consumed.toString(), reservedMicroUsd: current.reserved.toString(), availableMicroUsd: active && remaining > 0n ? remaining.toString() : '0' } : null,
    }
}
async function sourcePlan(manager: EntityManager, account: HostingAccount, grant: HostingGrant): Promise<HostedPlanId | null> {
    if (grant.sourceKey.startsWith('trial:') || grant.sourceKey.startsWith('assessment:')) return null
    if (grant.sourceKey.startsWith('stripe:')) {
        const period = await manager.getRepository(HostingStripePeriodEntity).findOneBy({ platformId: account.id, sourceKey: grant.sourceKey })
        if (!period || period.revokedAt || !['starter', 'team'].includes(period.planId) || !sameTime(grant.validFrom, period.periodStart) || !sameTime(grant.validUntil, period.periodEnd)) hostingFail('HOSTING_AI_ALLOWANCE_SOURCE_INVALID')
        return period.planId
    }
    const parsed = /^training:([a-zA-Z0-9_-]{21}):(0|1|2)$/.exec(grant.sourceKey)
    if (parsed) {
        const record = await manager.getRepository(HostingTrainingEntity).findOneBy({ id: parsed[1], platformId: account.id })
        const period = Number(parsed[2]), periodMs = hostingCatalog.trainingPeriodDays * 86_400_000
        if (!record || record.revokedAt || record.identityId !== account.ownerIdentityId || period >= hostingCatalog.trainingPeriods[record.tier] || !sameTime(grant.validFrom, new Date(record.startsAt.getTime() + period * periodMs)) || !sameTime(grant.validUntil, new Date(record.startsAt.getTime() + (period + 1) * periodMs)) || grant.validUntil > record.endsAt) hostingFail('HOSTING_AI_ALLOWANCE_SOURCE_INVALID')
        return 'training'
    }
    hostingFail('HOSTING_AI_ALLOWANCE_SOURCE_INVALID')
}
function sameTime(a: Date, b: Date): boolean {
    return a.getTime() === b.getTime() 
}
function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex') 
}
function isRequestCollision(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'uq_hosting_ai_allowance_actor_request'
}
