import { HostedPlanId, hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager, IsNull, LessThanOrEqual } from 'typeorm'
import { z } from 'zod'
import { assertHostingOperator } from './hosting-access-policy'
import { HostingAiAllowanceBindingEntity, HostingAiAllowanceChangeEntity } from './hosting-ai-allowance-entities'
import { HostingAccount, HostingGrantEntity } from './hosting-entities'
import { hostingGrantMatchesPlan } from './hosting-plan-grants'
import { subscriptionAccountActive, subscriptionGrantActive, subscriptionGrantUntil } from './hosting-subscription-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const HostingAiAllowanceInput = z.strictObject({
    platformId: z.string().length(21), expectedRevision: z.number().int().nonnegative().max(1000),
    requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), monthlyCredits: z.number().int().min(0).max(1_000_000).nullable(), reason: z.string().trim().max(500).default(''),
})
export type HostingAiAllowanceInput = z.input<typeof HostingAiAllowanceInput>

// Retained for historical diagnostic compatibility. No new grant issuer or
// managed AI admission path may use this retired supplier-budget policy.
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
    // Historical diagnostics only. This retired API must never mutate supplier
    // budgets or mint another customer allowance after the single-wallet upgrade.
    async function save({ actor, input }: { actor: HostingActor, input: HostingAiAllowanceInput }): Promise<never> {
        const value = HostingAiAllowanceInput.parse(input)
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await tx.account({ manager, platformId: value.platformId })
            hostingFail('HOSTING_AI_ALLOWANCE_RETIRED_USE_CREDITS')
        } })
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
    const grants = await manager.getRepository(HostingGrantEntity).find({ where: { platformId: account.id, meter: 'managed_ai', validFrom: LessThanOrEqual(now), revokedAt: IsNull() }, order: { validFrom: 'DESC', id: 'ASC' }, take: 257 })
    if (grants.length > 256) hostingFail('HOSTING_AI_ALLOWANCE_GRANT_LIMIT')
    const current = grants.find(grant => hostingGrantMatchesPlan(grant, account.planId) && subscriptionGrantActive(account, grant, now))
    const remaining = current ? current.amount - current.consumed - current.reserved : 0n
    const active = subscriptionAccountActive(account, now)
    return {
        scopePlatformId: account.id, revision: binding?.revision ?? 0, planId: account.planId, overrideMonthlyCredits: change?.monthlyCredits ?? null, defaultMonthlyCredits,
        effectiveMonthlyCredits: account.planId === 'assessment' ? defaultMonthlyCredits : change?.monthlyCredits ?? defaultMonthlyCredits, appliesToCurrentPeriod: account.planId !== 'trial' && account.planId !== 'assessment' && !!current && account.validUntil > now,
        period: current ? { validFrom: current.validFrom.toISOString(), validUntil: subscriptionGrantUntil(account, current).toISOString(), amountMicroUsd: current.amount.toString(), consumedMicroUsd: current.consumed.toString(), reservedMicroUsd: current.reserved.toString(), availableMicroUsd: active && remaining > 0n ? remaining.toString() : '0' } : null,
    }
}
