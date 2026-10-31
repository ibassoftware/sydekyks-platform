import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { HostedPlanId, HOSTED_PARTNER_STARTER_MONTHLY_CREDITS, hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager, IsNull } from 'typeorm'
import { z } from 'zod'
import { assertHostingOperator } from './hosting-access-policy'
import { CreditAllowanceSnapshot, HostingCreditAllowanceBindingEntity, HostingCreditAllowanceChangeEntity } from './hosting-credit-allowance-entities'
import { hostedCreditLiability } from './hosting-credit-policy'
import { HostingAccount, HostingAccountEntity, HostingGrant, HostingGrantEntity, HostingLedgerEntity } from './hosting-entities'
import { currentManualTerm, manualGrantPlan } from './hosting-manual-terms'
import { hasOperatorCreditFunding, HOSTED_OPERATOR_MONTHLY_CREDITS } from './hosting-operator-credits'
import { assertPartnerStarterAllowance, isPartnerStarter } from './hosting-partner-starter'
import { hostingGrantMatchesPlan } from './hosting-plan-grants'
import { HostingStripePeriodEntity } from './hosting-stripe-entities'
import { subscriptionAccountActive, subscriptionGrantActive, subscriptionGrantUntil } from './hosting-subscription-policy'
import { HostingTrainingEntity } from './hosting-training-entity'
import { fundedTrainingPeriods } from './hosting-training-periods'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const HostingCreditAllowanceInput = z.strictObject({
    platformId: z.string().length(21), expectedRevision: z.number().int().nonnegative().max(1000),
    requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), monthlyCredits: z.number().int().min(0).max(1_000_000).nullable(), reason: z.string().trim().min(3).max(500),
})
export type HostingCreditAllowanceInput = z.input<typeof HostingCreditAllowanceInput>

// Grant issuers already hold the account lock. Trial/assessment remain fixed;
// the policy changes funded periods only and can never renew access by itself.
export async function effectiveHostedCredits(manager: EntityManager, platformId: string, planId: HostedPlanId): Promise<number> {
    if (planId === 'team' && await hasOperatorCreditFunding(manager, platformId)) return HOSTED_OPERATOR_MONTHLY_CREDITS
    if (planId === 'trial' || planId === 'assessment') return hostingCatalog.getPlan({ planId }).executions
    const { change } = await currentPolicy(manager, platformId)
    const credits = change?.monthlyCredits ?? await fundedDefaultCredits(manager, platformId, planId)
    return planId === 'training' && await isPartnerStarter(manager, platformId) ? Math.min(credits, HOSTED_PARTNER_STARTER_MONTHLY_CREDITS) : credits
}
export function createHostedCreditAllowance({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }) {
    async function read({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const user = await assertHostingOperator({ manager, actor }), account = await tx.account({ manager, platformId })
            await assertHostingOperator({ manager, actor })
            return { ...await view(manager, account, await tx.now(manager)), platformId: actor.platformId, userId: user.id }
        } })
    }
    async function save({ actor, input }: { actor: HostingActor, input: HostingCreditAllowanceInput }) {
        const value = HostingCreditAllowanceInput.parse(input), payloadHash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
        try {
            return await tx.run({ dataSource, manager: existingManager, fn: async manager => {
                const user = await assertHostingOperator({ manager, actor }), account = await tx.account({ manager, platformId: value.platformId })
                await assertHostingOperator({ manager, actor })
                const prior = await manager.getRepository(HostingCreditAllowanceChangeEntity).findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
                if (prior) {
                    if (prior.payloadHash !== payloadHash || prior.platformId !== account.id) hostingFail('HOSTING_CREDIT_ALLOWANCE_IDEMPOTENCY_CONFLICT')
                    return { ...await view(manager, account, await tx.now(manager)), platformId: actor.platformId, userId: user.id }
                }
                if (account.planId === 'trial' || account.planId === 'assessment') hostingFail('HOSTING_CREDIT_ALLOWANCE_FIXED_ENTITLEMENT')
                if (await hasOperatorCreditFunding(manager, account.id)) hostingFail('HOSTING_CREDIT_ALLOWANCE_FIXED_ENTITLEMENT')
                await assertPartnerStarterAllowance(manager, account.id, value.monthlyCredits)
                const now = await tx.now(manager), { binding, change: previous } = await currentPolicy(manager, account.id)
                if ((binding?.revision ?? 0) !== value.expectedRevision) hostingFail('HOSTING_CREDIT_ALLOWANCE_REVISION_CONFLICT')
                if ((binding?.revision ?? 0) >= 1000) hostingFail('HOSTING_CREDIT_ALLOWANCE_HISTORY_LIMIT')
                const rows = await manager.getRepository(HostingGrantEntity).find({ where: { platformId: account.id, meter: 'execution', revokedAt: IsNull() }, order: { validFrom: 'ASC', id: 'ASC' }, take: 257 })
                if (rows.length > 256) hostingFail('HOSTING_CREDIT_ALLOWANCE_GRANT_LIMIT')
                const updates: { grant: HostingGrant, planId: HostedPlanId, amount: bigint, consumed: bigint, reserved: bigint }[] = []
                for (const grant of rows) {
                    // Earlier periods and revoked funds stay historical. During a
                    // verified grace window only that funded period is eligible.
                    if (subscriptionGrantUntil(account, grant) <= now || !hostingGrantMatchesPlan(grant, account.planId)) continue
                    const planId = await sourcePlan(manager, account, grant)
                    if (!planId) continue
                    const liability = await hostedCreditLiability(manager, grant.id), consumed = grant.consumed + liability.consumed, reserved = grant.reserved + liability.reserved
                    const amount = BigInt(value.monthlyCredits ?? await fundedDefaultCredits(manager, account.id, planId))
                    if (amount < consumed + reserved) hostingFail('HOSTING_CREDIT_ALLOWANCE_BELOW_COMMITTED')
                    updates.push({ grant, planId, amount, consumed, reserved })
                }
                const snapshots: CreditAllowanceSnapshot[] = updates.map(({ grant, planId, amount, consumed, reserved }) => ({ grantId: grant.id, sourceKey: grant.sourceKey, planId, validFrom: grant.validFrom.toISOString(), validUntil: grant.validUntil.toISOString(), previousAmount: grant.amount.toString(), amount: amount.toString(), consumed: consumed.toString(), reserved: reserved.toString() }))
                const change = await manager.getRepository(HostingCreditAllowanceChangeEntity).save({ id: apId(), platformId: account.id, revision: (binding?.revision ?? 0) + 1, operatorIdentityId: actor.identityId, requestKey: value.requestKey, payloadHash, monthlyCredits: value.monthlyCredits, previousMonthlyCredits: previous?.monthlyCredits ?? null, reason: value.reason, grantSnapshots: snapshots })
                for (const { grant, amount } of updates) {
                    if (amount === grant.amount) continue
                    await manager.getRepository(HostingGrantEntity).update({ id: grant.id, platformId: account.id }, { amount })
                    const delta = amount - grant.amount
                    await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId: grant.id, reservationId: null, operation: delta > 0n ? 'grant' : 'revoke', key: `credit-allowance:${change.id}:${grant.id}`, amount: delta > 0n ? delta : -delta })
                }
                await manager.getRepository(HostingCreditAllowanceBindingEntity).save({ id: binding?.id ?? apId(), platformId: account.id, revision: change.revision, changeId: change.id })
                await tx.event({ manager, platformId: account.id, event: 'credits.allowance_changed', payload: { changeId: change.id, revision: change.revision, monthlyCredits: value.monthlyCredits, previousMonthlyCredits: previous?.monthlyCredits ?? null, operatorIdentityId: actor.identityId, adjustedGrants: snapshots.length } })
                return { ...await view(manager, account, now), platformId: actor.platformId, userId: user.id }
            } })
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'uq_hosting_credit_allowance_actor_request') hostingFail('HOSTING_CREDIT_ALLOWANCE_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    return { read, save }
}
// A manually funded contract is its own default. A separate audited allowance
// override may change eligible grants; clearing it restores that funded amount.
async function fundedDefaultCredits(manager: EntityManager, platformId: string, planId: HostedPlanId): Promise<number> {
    if (planId === 'team' && await hasOperatorCreditFunding(manager, platformId)) return HOSTED_OPERATOR_MONTHLY_CREDITS
    const account = await manager.getRepository(HostingAccountEntity).findOneBy({ id: platformId })
    const manual = account?.planId === planId ? await currentManualTerm(manager, account) : null
    return manual?.monthlyCredits ?? hostingCatalog.getPlan({ planId, catalogVersion: account?.planId === planId ? account.catalogVersion : undefined }).executions
}
async function currentPolicy(manager: EntityManager, platformId: string) {
    const binding = await manager.getRepository(HostingCreditAllowanceBindingEntity).findOneBy({ platformId })
    const change = binding ? await manager.getRepository(HostingCreditAllowanceChangeEntity).findOneBy({ id: binding.changeId, platformId, revision: binding.revision }) : null
    if (binding && !change) hostingFail('HOSTING_CREDIT_ALLOWANCE_POLICY_INVALID')
    return { binding, change }
}
async function view(manager: EntityManager, account: HostingAccount, now: Date) {
    const { binding, change } = await currentPolicy(manager, account.id), fixed = account.planId === 'trial' || account.planId === 'assessment' || await hasOperatorCreditFunding(manager, account.id)
    const defaultMonthlyCredits = await fundedDefaultCredits(manager, account.id, account.planId)
    const monthlyCreditCap = account.planId === 'training' && await isPartnerStarter(manager, account.id) ? HOSTED_PARTNER_STARTER_MONTHLY_CREDITS : null
    const grants = await manager.getRepository(HostingGrantEntity).find({ where: { platformId: account.id, meter: 'execution', revokedAt: IsNull() }, order: { validFrom: 'DESC', id: 'ASC' }, take: 257 })
    const current = grants.find(grant => hostingGrantMatchesPlan(grant, account.planId) && subscriptionGrantActive(account, grant, now))
    const liability = current ? await hostedCreditLiability(manager, current.id) : { reserved: 0n, consumed: 0n }
    const consumed = (current?.consumed ?? 0n) + liability.consumed, reserved = (current?.reserved ?? 0n) + liability.reserved
    const remaining = current ? current.amount - consumed - reserved : 0n
    return {
        scopePlatformId: account.id, monthlyCreditCap, revision: binding?.revision ?? 0, planId: account.planId, fixed, overrideMonthlyCredits: change?.monthlyCredits ?? null, defaultMonthlyCredits,
        effectiveMonthlyCredits: fixed ? defaultMonthlyCredits : change?.monthlyCredits ?? defaultMonthlyCredits, appliesToCurrentPeriod: !fixed && !!current && subscriptionAccountActive(account, now),
        period: current ? { validFrom: current.validFrom.toISOString(), validUntil: subscriptionGrantUntil(account, current).toISOString(), amount: current.amount.toString(), consumed: consumed.toString(), reserved: reserved.toString(), available: subscriptionAccountActive(account, now) && remaining > 0n ? remaining.toString() : '0' } : null,
    }
}
async function sourcePlan(manager: EntityManager, account: HostingAccount, grant: HostingGrant): Promise<HostedPlanId | null> {
    if (grant.sourceKey.startsWith('trial:') || grant.sourceKey.startsWith('assessment:')) return null
    if (grant.sourceKey.startsWith('manual:')) return manualGrantPlan(manager, account, grant)
    if (grant.sourceKey.startsWith('stripe:')) {
        const period = await manager.getRepository(HostingStripePeriodEntity).findOneBy({ platformId: account.id, sourceKey: grant.sourceKey })
        if (!period || period.revokedAt || !['starter', 'team', 'scale'].includes(period.planId) || !same(grant.validFrom, period.periodStart) || !same(grant.validUntil, period.periodEnd)) hostingFail('HOSTING_CREDIT_ALLOWANCE_SOURCE_INVALID')
        return period.planId
    }
    const parsed = /^training:([a-zA-Z0-9_-]{21}):(\d{1,2})$/.exec(grant.sourceKey)
    if (parsed) {
        const record = await manager.getRepository(HostingTrainingEntity).findOneBy({ id: parsed[1], platformId: account.id })
        const periods = record ? fundedTrainingPeriods(record) : null, period = periods?.[Number(parsed[2])]
        if (!record || record.revokedAt || record.identityId !== account.ownerIdentityId || !period || !same(grant.validFrom, period.from) || !same(grant.validUntil, period.until)) hostingFail('HOSTING_CREDIT_ALLOWANCE_SOURCE_INVALID')
        return 'training'
    }
    hostingFail('HOSTING_CREDIT_ALLOWANCE_SOURCE_INVALID')
}
function same(a: Date, b: Date) {
    return a.getTime() === b.getTime()
}
