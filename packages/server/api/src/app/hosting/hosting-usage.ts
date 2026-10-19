import { hostingCatalog } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { HostingAccount, HostingGrant, HostingGrantEntity } from './hosting-entities'
import { hostingGrantMatchesPlan } from './hosting-plan-grants'
import { subscriptionAccountActive, subscriptionGrantActive, subscriptionGrantUntil } from './hosting-subscription-policy'

// Account lock is held by callers, matching ledger writers. No provider or Stripe reads.
export async function readHostedCredits(manager: EntityManager, account: HostingAccount, now: Date) {
    const grants = await manager.getRepository(HostingGrantEntity).find({ where: { platformId: account.id }, order: { validFrom: 'DESC', id: 'ASC' } })
    const candidates = grants.filter(grant => grant.meter === 'execution' && hostingGrantMatchesPlan(grant, account.planId) && grant.validFrom <= now)
    const current = candidates.find(grant => subscriptionGrantActive(account, grant, now)) ?? candidates[0]
    const ai = grants.find(grant => grant.meter === 'managed_ai' && grant.sourceKey === current?.sourceKey)
    const meter = (grant: HostingGrant | undefined, scale: bigint, multiplier: bigint) => {
        const active = grant && subscriptionGrantActive(account, grant, now)
        const entitled = subscriptionAccountActive(account, now)
        const remaining = grant ? grant.amount - grant.reserved - grant.consumed : 0n
        return { scale: scale.toString(), amount: ((grant?.amount ?? 0n) * multiplier).toString(), consumed: ((grant?.consumed ?? 0n) * multiplier).toString(), reserved: ((grant?.reserved ?? 0n) * multiplier).toString(), available: (active && entitled && remaining > 0n ? remaining * multiplier : 0n).toString(), validUntil: grant ? subscriptionGrantUntil(account, grant).toISOString() : null }
    }
    return { execution: meter(current, 1n, 1n), ai: meter(ai, 1_000_000n, BigInt(hostingCatalog.microcreditsPerMicroUsd)), previousHeldAi: (grants.filter(grant => grant.meter === 'managed_ai' && grant.id !== ai?.id).reduce((sum, grant) => sum + grant.reserved, 0n) * BigInt(hostingCatalog.microcreditsPerMicroUsd)).toString() }
}
