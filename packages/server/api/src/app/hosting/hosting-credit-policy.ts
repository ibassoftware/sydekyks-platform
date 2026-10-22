import { hostingCatalog } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { HostingReservationEntity } from './hosting-entities'
import { hostingFail } from './hosting-transactions'

export const HOSTED_CREDIT_ACCOUNTING_VERSION = 'single-credits-1500-microusd-v3'
export const HOSTED_LEGACY_MICRO_USD_PER_CREDIT = 500n
export const HOSTED_MAX_ROOT_CREDITS = 1000n

export function hostedUsesCreditAccounting(version: string | null | undefined): boolean {
    if (version == null) return false
    if (version === 'single-credits-500-microusd-v1' || version === 'single-credits-250-microusd-v2' || version === HOSTED_CREDIT_ACCOUNTING_VERSION) return true
    hostingFail('HOSTING_AI_ACCOUNTING_VERSION_INVALID')
}

export function hostedCreditRate(): bigint {
    const rate = BigInt(hostingCatalog.aiMicroUsdPerCredit)
    if (rate <= 0n) hostingFail('HOSTING_AI_PRICE_INVALID')
    return rate
}

export function hostedAiCredits(costMicroUsd: bigint, microUsdPerCredit = hostedCreditRate()): bigint {
    if (costMicroUsd < 0n || microUsdPerCredit <= 0n) hostingFail('HOSTING_INVALID_AMOUNT')
    return (costMicroUsd + microUsdPerCredit - 1n) / microUsdPerCredit
}

// Only unresolved legacy calls at the migration boundary are linked here. Existing
// completed history is never retroactively charged and legacy grants never become
// spendable Credits. A linked pending hold becomes consumed liability on settlement.
export async function hostedCreditLiability(manager: EntityManager, grantId: string): Promise<{ reserved: bigint, consumed: bigint }> {
    const calls = await manager.getRepository(HostingReservationEntity).findBy({ legacyCreditGrantId: grantId })
    return calls.reduce((sum, call) => {
        const rate = call.microUsdPerCredit ?? HOSTED_LEGACY_MICRO_USD_PER_CREDIT
        if (['reserved', 'running', 'uncertain'].includes(call.state)) sum.reserved += hostedAiCredits(call.amount, rate)
        if (call.state === 'settled') sum.consumed += hostedAiCredits(call.actualAmount ?? call.amount, rate)
        return sum
    }, { reserved: 0n, consumed: 0n })
}
