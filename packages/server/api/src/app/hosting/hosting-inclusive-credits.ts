import { EntityManager } from 'typeorm'
import { HOSTED_INCLUSIVE_CREDIT_ACCOUNTING_VERSION, hostedAiCredits } from './hosting-credit-policy'
import { HostingGrantEntity, HostingReservation, HostingReservationEntity } from './hosting-entities'
import { HostingRootCreditUsageEntity } from './hosting-inclusive-credits-entity'
import { hostingFail, hostingTransactions as tx } from './hosting-transactions'

export type HostedInclusiveExposure = {
    consumedCredits: bigint
    reservedCredits: bigint
    totalCredits: bigint
    settledSupplierMicroUsd: bigint
    heldSupplierMicroUsd: bigint
}

export function hostedInclusiveCredits(root: Pick<HostingReservation, 'accountingVersion'>): boolean {
    return root.accountingVersion === HOSTED_INCLUSIVE_CREDIT_ACCOUNTING_VERSION
}

// Supplier costs remain per call. Only the execution root owns rounded Credits.
// This makes call order and splitting a request irrelevant to its final charge.
export function hostedInclusiveExposure({ root, children, additionalSupplierMicroUsd = 0n }: { root: HostingReservation, children: HostingReservation[], additionalSupplierMicroUsd?: bigint }): HostedInclusiveExposure {
    const rate = root.microUsdPerCredit
    if (!hostedInclusiveCredits(root) || root.kind !== 'execution' || root.amount !== 1n || rate == null || rate <= 0n || additionalSupplierMicroUsd < 0n) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    let settledSupplierMicroUsd = 0n, heldSupplierMicroUsd = additionalSupplierMicroUsd
    for (const child of children) {
        if (!hostedInclusiveCredits(child) || child.kind !== 'managed_ai' || child.rootReservationId !== root.id || child.platformId !== root.platformId || child.grantId !== root.grantId || child.microUsdPerCredit !== rate || child.amount !== 0n || child.payer !== 'managed') hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
        if (child.state === 'released') continue
        if (child.state === 'settled') {
            if (child.actualSupplierMicroUsd == null || child.actualSupplierMicroUsd < 0n || child.actualAmount !== 0n) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
            settledSupplierMicroUsd += child.actualSupplierMicroUsd
        }
        else if (['reserved', 'running', 'uncertain', 'paused'].includes(child.state)) {
            if (child.supplierMaxMicroUsd == null || child.supplierMaxMicroUsd <= 0n) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
            heldSupplierMicroUsd += child.supplierMaxMicroUsd
        }
        else hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    }
    if (root.payer === 'byok' && (settledSupplierMicroUsd > 0n || heldSupplierMicroUsd > 0n || children.length)) hostingFail('HOSTING_BYOK_HAS_NO_MANAGED_ALLOWANCE')
    if (root.state === 'released' || root.state === 'settled' && root.actualAmount === 0n) {
        if (settledSupplierMicroUsd !== 0n || heldSupplierMicroUsd !== 0n) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
        return { consumedCredits: 0n, reservedCredits: 0n, totalCredits: 0n, settledSupplierMicroUsd, heldSupplierMicroUsd }
    }
    if (root.state === 'reserved') {
        if (settledSupplierMicroUsd !== 0n || heldSupplierMicroUsd !== 0n) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
        return { consumedCredits: 0n, reservedCredits: 1n, totalCredits: 1n, settledSupplierMicroUsd, heldSupplierMicroUsd }
    }
    if (!['running', 'uncertain', 'paused', 'settled'].includes(root.state) || root.state === 'settled' && heldSupplierMicroUsd !== 0n) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    const consumedCredits = atLeastOne(hostedAiCredits(settledSupplierMicroUsd, rate))
    const totalCredits = atLeastOne(hostedAiCredits(settledSupplierMicroUsd + heldSupplierMicroUsd, rate))
    return { consumedCredits, reservedCredits: totalCredits - consumedCredits, totalCredits, settledSupplierMicroUsd, heldSupplierMicroUsd }
}

// Caller holds the existing account lock, and (for supplier transitions) the
// supplier-day lock first. State changes and these deltas commit atomically.
export async function reconcileHostedInclusiveCredits({ manager, root, key, operation = 'settle' }: { manager: EntityManager, root: HostingReservation, key: string, operation?: 'dispatch' | 'settle' }): Promise<HostedInclusiveExposure> {
    const children = await manager.getRepository(HostingReservationEntity).findBy({ platformId: root.platformId, rootReservationId: root.id, kind: 'managed_ai' })
    const next = hostedInclusiveExposure({ root, children })
    const rate = root.microUsdPerCredit
    if (rate == null) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    const repository = manager.getRepository(HostingRootCreditUsageEntity)
    const prior = await repository.findOneBy({ id: root.id, platformId: root.platformId })
    if (!prior && root.state !== 'reserved') hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    if (prior && (prior.grantId !== root.grantId || prior.microUsdPerCredit !== root.microUsdPerCredit)) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    const oldConsumed = prior?.consumedCredits ?? 0n, oldReserved = prior?.reservedCredits ?? 0n
    const consumedDelta = next.consumedCredits - oldConsumed, reservedDelta = next.reservedCredits - oldReserved
    if (consumedDelta < 0n && !(root.state === 'settled' && root.actualAmount === 0n)) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    if (prior && consumedDelta === 0n && reservedDelta === 0n && prior.settledSupplierMicroUsd === next.settledSupplierMicroUsd && prior.heldSupplierMicroUsd === next.heldSupplierMicroUsd) return next
    const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId, platformId: root.platformId })
    if (grant.consumed + consumedDelta < 0n || grant.reserved + reservedDelta < 0n) hostingFail('HOSTING_INCLUSIVE_ACCOUNTING_INVALID')
    await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { consumed: grant.consumed + consumedDelta, reserved: grant.reserved + reservedDelta })
    const revision = (prior?.revision ?? 0) + 1
    await repository.save({ id: root.id, platformId: root.platformId, grantId: root.grantId, microUsdPerCredit: rate, consumedCredits: next.consumedCredits, reservedCredits: next.reservedCredits, settledSupplierMicroUsd: next.settledSupplierMicroUsd, heldSupplierMicroUsd: next.heldSupplierMicroUsd, revision })
    const prefix = `inclusive:${root.id}:${revision}`
    if (reservedDelta > 0n) await tx.entry({ manager, reservation: root, operation: 'reserve', amount: reservedDelta, key: `${prefix}:reserve` })
    if (reservedDelta < 0n) await tx.entry({ manager, reservation: root, operation: 'release', amount: -reservedDelta, key: `${prefix}:release` })
    if (consumedDelta > 0n) await tx.entry({ manager, reservation: root, operation, amount: consumedDelta, key: `${prefix}:consume` })
    if (consumedDelta < 0n) await tx.entry({ manager, reservation: root, operation: 'release', amount: -consumedDelta, key: `${prefix}:refund` })
    // Moving a held Credit into consumed is not released liability on a revoked grant.
    const releasedExposure = oldConsumed + oldReserved - next.totalCredits
    if (grant.revokedAt && releasedExposure > 0n) await tx.entry({ manager, reservation: root, operation: 'revoke', amount: releasedExposure, key: `${prefix}:revoke` })
    await tx.event({ manager, platformId: root.platformId, event: 'execution.credits_reconciled', payload: { rootReservationId: root.id, trigger: key, revision, priorConsumedCredits: oldConsumed.toString(), priorReservedCredits: oldReserved.toString(), consumedCredits: next.consumedCredits.toString(), reservedCredits: next.reservedCredits.toString(), consumedDelta: consumedDelta.toString(), reservedDelta: reservedDelta.toString(), settledSupplierMicroUsd: next.settledSupplierMicroUsd.toString(), heldSupplierMicroUsd: next.heldSupplierMicroUsd.toString(), microUsdPerCredit: rate.toString() } })
    return next
}

function atLeastOne(value: bigint): bigint {
    return value > 1n ? value : 1n
}
