import { apId } from '@activepieces/core-utils'
import { hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager, In, IsNull } from 'typeorm'
import { HOSTED_ADDITIVE_CREDIT_ACCOUNTING_VERSION, HOSTED_CREDIT_ACCOUNTING_VERSION, HOSTED_LEGACY_MICRO_USD_PER_CREDIT, HOSTED_MAX_ROOT_CREDITS, hostedAiCredits, hostedCreditLiability, hostedCreditRate, hostedUsesCreditAccounting } from './hosting-credit-policy'
import { HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingAccountEntity, HostingDailyBudgetEntity, HostingGrant, HostingGrantEntity, HostingReservation, HostingReservationEntity } from './hosting-entities'
import { hostedInclusiveCredits, hostedInclusiveExposure, reconcileHostedInclusiveCredits } from './hosting-inclusive-credits'
import { hasDefinitiveHostedCompletion, isHostedCoordinatorJob } from './hosting-job-policy'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { hostingGrantMatchesPlan } from './hosting-plan-grants'
import { assertHostedStorageAdmission } from './hosting-storage'
import { subscriptionAccountActive, subscriptionGrantActive, subscriptionGrantUntil } from './hosting-subscription-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export function createHostedLedger({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }) {
    async function reserveExecution({ actor, projectId, key, payer }: { actor: HostingActor, projectId: string, key: string, payer: 'managed' | 'byok' }): Promise<HostingReservation> {
        tx.assertKey(key)
        if (payer !== 'managed' && payer !== 'byok') hostingFail('HOSTING_INVALID_PAYER')
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            await tx.member({ manager, actor, projectId, write: true })
            const existing = await manager.getRepository(HostingReservationEntity).findOneBy({ platformId: actor.platformId, kind: 'execution', key })
            if (existing) {
                if (existing.projectId !== projectId || existing.identityId !== actor.identityId || existing.payer !== payer) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return existing
            }
            const now = await tx.now(manager)
            tx.assertActive({ account, now })
            await assertHostedStorageAdmission(manager, account.id)
            const grant = await activeGrant({ manager, account, platformId: account.id, meter: 'execution', now, planId: account.planId })
            const liability = await hostedCreditLiability(manager, grant.id)
            if (grant.amount - grant.reserved - grant.consumed - liability.reserved - liability.consumed < 1n) hostingFail('HOSTING_CREDITS_EXHAUSTED')
            if (account.activeExecutions >= hostingCatalog.getPlan({ planId: account.planId }).concurrency) hostingFail('HOSTING_CONCURRENCY_LIMIT')
            const reservation = manager.getRepository(HostingReservationEntity).create({ id: apId(), platformId: account.id, projectId, identityId: actor.identityId, grantId: grant.id, key, kind: 'execution', payer, state: 'reserved', rootReservationId: null, day: null, amount: 1n, actualAmount: null, dispatchId: null, accountingVersion: HOSTED_CREDIT_ACCOUNTING_VERSION, microUsdPerCredit: hostedCreditRate(), maxRootCredits: HOSTED_MAX_ROOT_CREDITS })
            await manager.getRepository(HostingReservationEntity).save(reservation)
            if (hostedInclusiveCredits(reservation)) await reconcileHostedInclusiveCredits({ manager, root: reservation, key: `base-reserve:${reservation.id}` })
            else await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { reserved: grant.reserved + 1n })
            await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { activeExecutions: account.activeExecutions + 1 })
            if (!hostedInclusiveCredits(reservation)) await tx.entry({ manager, reservation, operation: 'reserve', amount: 1n })
            await tx.event({ manager, platformId: account.id, event: 'execution.reserved', payload: { reservationId: reservation.id } })
            return reservation
        } })
    }

    async function claimExecution({ actor, reservationId }: { actor: HostingActor, reservationId: string }): Promise<Claim> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            const reservation = await findReservation({ manager, platformId: actor.platformId, reservationId, kind: 'execution' })
            await tx.member({ manager, actor, projectId: reservation.projectId, write: true })
            assertOwner({ actor, reservation })
            if (reservation.state !== 'reserved') return { claimed: false, dispatchId: null }
            const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId, platformId: account.id })
            const now = await tx.now(manager)
            if (!subscriptionAccountActive(account, now) || !subscriptionGrantActive(account, grant, now)) {
                await release({ manager, reservation })
                return { claimed: false, dispatchId: null }
            }
            tx.assertActive({ account, now })
            const dispatchId = apId()
            await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'running', dispatchId })
            if (hostedInclusiveCredits(reservation)) await reconcileHostedInclusiveCredits({ manager, root: { ...reservation, state: 'running', dispatchId }, key: `base-dispatch:${reservation.id}`, operation: 'dispatch' })
            else {
                await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { reserved: grant.reserved - 1n, consumed: grant.consumed + 1n })
                await tx.entry({ manager, reservation, operation: 'dispatch', amount: 1n })
            }
            return { claimed: true, dispatchId }
        } })
    }

    async function finishExecution({ platformId, reservationId, dispatchId }: Fence): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const account = await tx.account({ manager, platformId })
            const reservation = await findReservation({ manager, platformId, reservationId, kind: 'execution' })
            assertFence({ reservation, dispatchId })
            if (reservation.state === 'settled') return
            if (!['running', 'uncertain', 'paused'].includes(reservation.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            if (await manager.getRepository(HostingReservationEntity).existsBy({ platformId, rootReservationId: reservation.id, state: In(['reserved', 'running', 'uncertain']) })) hostingFail('HOSTING_UNSETTLED_CHILDREN')
            if (await manager.getRepository(HostingModelCallEntity).existsBy({ platformId, rootReservationId: reservation.id, state: In(['prepared', 'running', 'uncertain']) })) hostingFail('HOSTING_UNSETTLED_CHILDREN')
            const coordinator = await isConfirmedCoordinator({ manager, reservation })
            const inclusive = hostedInclusiveCredits(reservation)
            const children = inclusive ? await manager.getRepository(HostingReservationEntity).findBy({ platformId, rootReservationId: reservation.id, kind: 'managed_ai' }) : []
            const actualAmount = coordinator ? 0n : inclusive ? hostedInclusiveExposure({ root: reservation, children }).consumedCredits : 1n
            if (coordinator && !inclusive) {
                const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId, platformId })
                if (grant.consumed < reservation.amount) hostingFail('HOSTING_INVALID_TRANSITION')
                await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { consumed: grant.consumed - reservation.amount })
                await tx.event({ manager, platformId, event: 'execution.coordinator_settled', payload: { reservationId: reservation.id, heldCredits: reservation.amount.toString(), actualCredits: '0' } })
            }
            await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'settled', actualAmount })
            if (inclusive) await reconcileHostedInclusiveCredits({ manager, root: { ...reservation, state: 'settled', actualAmount }, key: `root-finish:${reservation.id}` })
            if (reservation.state !== 'paused') await manager.getRepository(HostingAccountEntity).update({ id: platformId }, { activeExecutions: account.activeExecutions - 1 })
            if (!inclusive) await tx.entry({ manager, reservation, operation: 'settle', amount: actualAmount })
        } })
    }

    async function reserveManagedCall({ actor, rootReservationId, key, maxCostMicroUsd, expectedDay }: { actor: HostingActor, rootReservationId: string, key: string, maxCostMicroUsd: bigint, expectedDay?: string }): Promise<HostingReservation> {
        tx.assertKey(key)
        tx.assertAmount(maxCostMicroUsd)
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const day = utcDay(await tx.now(manager))
            if (expectedDay && day !== expectedDay) hostingFail('HOSTING_ADMISSION_DAY_CHANGED')
            const budget = await lockBudget({ manager, day, create: true })
            const account = await tx.account({ manager, platformId: actor.platformId })
            const root = await findReservation({ manager, platformId: account.id, reservationId: rootReservationId, kind: 'execution' })
            await tx.member({ manager, actor, projectId: root.projectId, write: true })
            assertOwner({ actor, reservation: root })
            const existing = await manager.getRepository(HostingReservationEntity).findOneBy({ platformId: account.id, kind: 'managed_ai', key })
            if (existing) {
                if (existing.rootReservationId !== root.id || existing.identityId !== actor.identityId || (existing.supplierMaxMicroUsd ?? existing.amount) !== maxCostMicroUsd) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return existing
            }
            if (root.payer !== 'managed') hostingFail('HOSTING_BYOK_HAS_NO_MANAGED_ALLOWANCE')
            if (root.state !== 'running') hostingFail('HOSTING_EXECUTION_NOT_RUNNING')
            const now = await tx.now(manager)
            if (day !== utcDay(now)) hostingFail('HOSTING_ADMISSION_DAY_CHANGED')
            tx.assertActive({ account, now })
            const executionGrant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId, platformId: account.id })
            tx.assertGrantActive({ grant: executionGrant, now, account })
            const grant = executionGrant
            const inclusive = hostedInclusiveCredits(root)
            const microUsdPerCredit = inclusive ? root.microUsdPerCredit ?? 0n : hostedCreditRate()
            const creditAmount = inclusive ? 0n : hostedAiCredits(maxCostMicroUsd, microUsdPerCredit)
            const children = await manager.getRepository(HostingReservationEntity).findBy({ platformId: account.id, rootReservationId: root.id, kind: 'managed_ai' })
            if (children.some(child => child.state === 'uncertain')) hostingFail('HOSTING_AI_OUTCOME_UNCERTAIN')
            const currentExposure = inclusive ? hostedInclusiveExposure({ root, children }) : null
            const proposedExposure = inclusive ? hostedInclusiveExposure({ root, children, additionalSupplierMicroUsd: maxCostMicroUsd }) : null
            const additionalCredits = proposedExposure && currentExposure ? proposedExposure.totalCredits - currentExposure.totalCredits : creditAmount
            const liability = await hostedCreditLiability(manager, grant.id)
            if (grant.amount - grant.reserved - grant.consumed - liability.reserved - liability.consumed < additionalCredits) hostingFail('HOSTING_CREDITS_EXHAUSTED')
            const proposedTotal = proposedExposure?.totalCredits ?? children.reduce((total, child) => total + reservationCreditExposure(child), root.amount) + creditAmount
            if (proposedTotal > (root.maxRootCredits ?? HOSTED_MAX_ROOT_CREDITS)) hostingFail('HOSTING_RUN_CREDIT_LIMIT')
            if (budget.limit - budget.reserved - budget.consumed < maxCostMicroUsd) hostingFail('HOSTING_OPERATOR_BUDGET_EXHAUSTED')
            const reservation = manager.getRepository(HostingReservationEntity).create({ id: apId(), platformId: account.id, projectId: root.projectId, identityId: actor.identityId, grantId: grant.id, rootReservationId: root.id, kind: 'managed_ai', payer: 'managed', key, state: 'reserved', day, amount: creditAmount, actualAmount: inclusive ? 0n : null, dispatchId: null, accountingVersion: inclusive ? root.accountingVersion : HOSTED_ADDITIVE_CREDIT_ACCOUNTING_VERSION, supplierMaxMicroUsd: maxCostMicroUsd, actualSupplierMicroUsd: null, microUsdPerCredit })
            await manager.getRepository(HostingReservationEntity).save(reservation)
            if (inclusive) await reconcileHostedInclusiveCredits({ manager, root, key: `child-reserve:${reservation.id}` })
            else await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { reserved: grant.reserved + creditAmount })
            await manager.getRepository(HostingDailyBudgetEntity).update({ id: day }, { reserved: budget.reserved + maxCostMicroUsd })
            await tx.entry({ manager, reservation, operation: 'reserve', amount: creditAmount })
            return reservation
        } })
    }

    async function claimManagedCall({ actor, reservationId }: { actor: HostingActor, reservationId: string }): Promise<Claim> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const peek = await findReservation({ manager, platformId: actor.platformId, reservationId, kind: 'managed_ai' })
            await lockBudget({ manager, day: requiredDay(peek), create: false })
            const account = await tx.account({ manager, platformId: actor.platformId })
            const reservation = await findReservation({ manager, platformId: actor.platformId, reservationId, kind: 'managed_ai' })
            await tx.member({ manager, actor, projectId: reservation.projectId, write: true })
            assertOwner({ actor, reservation })
            if (reservation.state !== 'reserved') return { claimed: false, dispatchId: null }
            const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId, platformId: account.id })
            const root = await findReservation({ manager, platformId: account.id, reservationId: reservation.rootReservationId ?? '', kind: 'execution' })
            const executionGrant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId, platformId: account.id })
            const now = await tx.now(manager)
            if (requiredDay(reservation) !== utcDay(now) || root.state !== 'running' || !subscriptionAccountActive(account, now) || !subscriptionGrantActive(account, executionGrant, now) || !subscriptionGrantActive(account, grant, now)) {
                await release({ manager, reservation })
                return { claimed: false, dispatchId: null }
            }
            tx.assertActive({ account, now })
            const dispatchId = apId()
            await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'running', dispatchId })
            await tx.entry({ manager, reservation, operation: 'dispatch', amount: reservation.amount })
            return { claimed: true, dispatchId }
        } })
    }

    async function settleManagedCall({ platformId, reservationId, dispatchId, actualCostMicroUsd }: Fence & { actualCostMicroUsd: bigint }): Promise<void> {
        if (typeof actualCostMicroUsd !== 'bigint' || actualCostMicroUsd < 0n || actualCostMicroUsd > 10n ** 24n) hostingFail('HOSTING_INVALID_AMOUNT')
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const peek = await findReservation({ manager, platformId, reservationId, kind: 'managed_ai' })
            const budget = await lockBudget({ manager, day: requiredDay(peek), create: false })
            await tx.account({ manager, platformId })
            const reservation = await findReservation({ manager, platformId, reservationId, kind: 'managed_ai' })
            assertFence({ reservation, dispatchId })
            const unified = hostedUsesCreditAccounting(reservation.accountingVersion)
            const maxSupplierCost = reservation.supplierMaxMicroUsd ?? reservation.amount
            const inclusive = hostedInclusiveCredits(reservation)
            const actualCredits = inclusive ? 0n : unified ? hostedAiCredits(actualCostMicroUsd, reservation.microUsdPerCredit ?? 0n) : actualCostMicroUsd
            if (reservation.state === 'settled') {
                if ((unified ? reservation.actualSupplierMicroUsd : reservation.actualAmount) !== actualCostMicroUsd) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return
            }
            if (reservation.state !== 'running' && reservation.state !== 'uncertain') hostingFail('HOSTING_INVALID_TRANSITION')
            const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId, platformId })
            if (!inclusive) await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { reserved: grant.reserved - reservation.amount, consumed: grant.consumed + actualCredits })
            await manager.getRepository(HostingDailyBudgetEntity).update({ id: budget.id }, { reserved: budget.reserved - maxSupplierCost, consumed: budget.consumed + actualCostMicroUsd })
            await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'settled', actualAmount: actualCredits, actualSupplierMicroUsd: unified ? actualCostMicroUsd : null })
            if (inclusive) {
                const root = await findReservation({ manager, platformId, reservationId: reservation.rootReservationId ?? '', kind: 'execution' })
                if (!hostedInclusiveCredits(root)) hostingFail('HOSTING_AI_ACCOUNTING_VERSION_INVALID')
                await reconcileHostedInclusiveCredits({ manager, root, key: `child-settle:${reservation.id}` })
            }
            if (actualCostMicroUsd > maxSupplierCost) await manager.getRepository(HostingAccountEntity).update({ id: platformId }, { status: 'suspended' })
            await tx.entry({ manager, reservation, operation: 'settle', amount: actualCredits })
            if (!inclusive && grant.revokedAt && reservation.amount > actualCredits) await tx.entry({ manager, reservation, operation: 'revoke', amount: reservation.amount - actualCredits, key: `revoke-released:${reservation.id}` })
            await tx.event({ manager, platformId, event: actualCostMicroUsd > maxSupplierCost ? 'account.cost_bound_exceeded' : 'managed_call.settled', payload: { reservationId, actualCostMicroUsd: actualCostMicroUsd.toString(), actualCredits: actualCredits.toString(), accountingVersion: reservation.accountingVersion ?? 'legacy-microusd' } })
        } })
    }

    async function markUncertain({ platformId, reservationId, dispatchId, attemptKey }: Fence & { attemptKey?: string }): Promise<void> {
        if (attemptKey) tx.assertKey(attemptKey)
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await tx.account({ manager, platformId })
            const reservation = await findReservation({ manager, platformId, reservationId })
            assertFence({ reservation, dispatchId })
            if (reservation.state === 'uncertain') return
            if (reservation.state !== 'running') hostingFail('HOSTING_INVALID_TRANSITION')
            await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'uncertain' })
            await tx.entry({ manager, reservation, operation: 'uncertain', amount: reservation.amount, key: attemptKey ? `uncertain:${reservation.id}:${attemptKey}` : undefined })
            await tx.event({ manager, platformId, event: 'accounting.uncertain', payload: { reservationId } })
        } })
    }

    async function releaseUnsent({ actor, reservationId }: { actor: HostingActor, reservationId: string }): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const peek = await findReservation({ manager, platformId: actor.platformId, reservationId })
            if (peek.kind === 'managed_ai') await lockBudget({ manager, day: requiredDay(peek), create: false })
            await tx.account({ manager, platformId: actor.platformId })
            const reservation = await findReservation({ manager, platformId: actor.platformId, reservationId })
            await tx.member({ manager, actor })
            assertOwner({ actor, reservation })
            if (reservation.state === 'released') return
            if (reservation.state !== 'reserved') hostingFail('HOSTING_INVALID_TRANSITION')
            await release({ manager, reservation })
        } })
    }

    async function cancelUnsent({ platformId, reservationId }: { platformId: string, reservationId: string }): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const peek = await findReservation({ manager, platformId, reservationId })
            if (peek.kind === 'managed_ai') await lockBudget({ manager, day: requiredDay(peek), create: false })
            await tx.account({ manager, platformId })
            const reservation = await findReservation({ manager, platformId, reservationId })
            if (reservation.state === 'released') return
            if (reservation.state !== 'reserved') hostingFail('HOSTING_INVALID_TRANSITION')
            await release({ manager, reservation })
        } })
    }

    // Only the audited operator-resolution service calls this after it has locked
    // the exact call/root and recorded definitive external no-send evidence.
    async function releaseConfirmedNotSent({ platformId, reservationId, dispatchId, resolutionId }: Fence & { resolutionId: string }): Promise<void> {
        tx.assertKey(resolutionId)
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const peek = await findReservation({ manager, platformId, reservationId, kind: 'managed_ai' })
            await lockBudget({ manager, day: requiredDay(peek), create: false })
            await tx.account({ manager, platformId })
            const reservation = await findReservation({ manager, platformId, reservationId, kind: 'managed_ai' })
            assertFence({ reservation, dispatchId })
            if (!['running', 'uncertain'].includes(reservation.state)) hostingFail('HOSTING_INVALID_TRANSITION')
            await release({ manager, reservation })
            await tx.event({ manager, platformId, event: 'managed_call.confirmed_not_sent', payload: { reservationId, resolutionId } })
        } })
    }

    async function balance({ actor }: { actor: HostingActor }) {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            await tx.member({ manager, actor })
            const now = await tx.now(manager)
            const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId: actor.platformId })
            return Promise.all(grants.map(async grant => {
                const liability = grant.meter === 'execution' ? await hostedCreditLiability(manager, grant.id) : { reserved: 0n, consumed: 0n }
                const reserved = grant.reserved + liability.reserved, consumed = grant.consumed + liability.consumed
                return { ...grant, reserved, consumed, validUntil: subscriptionGrantUntil(account, grant), unit: grant.meter === 'execution' ? 'execution' : 'micro_usd', microcreditsPerUnit: grant.meter === 'managed_ai' ? BigInt(hostingCatalog.microcreditsPerMicroUsd) : null, available: subscriptionAccountActive(account, now) && hostingGrantMatchesPlan(grant, account.planId) && subscriptionGrantActive(account, grant, now) ? maxZero(grant.amount - reserved - consumed) : 0n }
            }))
        } })
    }

    async function parkExecution({ platformId, reservationId, dispatchId }: Fence): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const account = await tx.account({ manager, platformId })
            const reservation = await findReservation({ manager, platformId, reservationId, kind: 'execution' })
            assertFence({ reservation, dispatchId })
            if (reservation.state === 'paused') return
            if (reservation.state !== 'running' && reservation.state !== 'uncertain') hostingFail('HOSTING_INVALID_TRANSITION')
            if (await manager.getRepository(HostingReservationEntity).existsBy({ platformId, rootReservationId: reservation.id, state: In(['reserved', 'running', 'uncertain']) })) hostingFail('HOSTING_UNSETTLED_CHILDREN')
            if (await manager.getRepository(HostingModelCallEntity).existsBy({ platformId, rootReservationId: reservation.id, state: In(['prepared', 'running', 'uncertain']) })) hostingFail('HOSTING_UNSETTLED_CHILDREN')
            await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'paused' })
            await manager.getRepository(HostingAccountEntity).update({ id: platformId }, { activeExecutions: account.activeExecutions - 1 })
            await tx.event({ manager, platformId, event: 'execution.parked', payload: { reservationId } })
        } })
    }

    async function resumeExecution({ actor, reservationId }: { actor: HostingActor, reservationId: string }): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            const reservation = await findReservation({ manager, platformId: actor.platformId, reservationId, kind: 'execution' })
            await tx.member({ manager, actor, projectId: reservation.projectId, write: true })
            assertOwner({ actor, reservation })
            const now = await tx.now(manager)
            tx.assertActive({ account, now })
            const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId, platformId: actor.platformId })
            tx.assertGrantActive({ grant, now, account })
            if (reservation.state === 'running') return
            if (reservation.state !== 'paused') hostingFail('HOSTING_INVALID_TRANSITION')
            if (account.activeExecutions >= hostingCatalog.getPlan({ planId: account.planId }).concurrency) hostingFail('HOSTING_CONCURRENCY_LIMIT')
            await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'running' })
            await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { activeExecutions: account.activeExecutions + 1 })
            await tx.event({ manager, platformId: account.id, event: 'execution.resumed', payload: { reservationId } })
        } })
    }

    return { reserveExecution, claimExecution, finishExecution, parkExecution, resumeExecution, reserveManagedCall, claimManagedCall, settleManagedCall, markUncertain, releaseUnsent, cancelUnsent, releaseConfirmedNotSent, balance }
}

async function activeGrant({ manager, account, platformId, meter, now, planId }: { manager: EntityManager, account: import('./hosting-entities').HostingAccount, platformId: string, meter: 'execution' | 'managed_ai', now: Date, planId: import('@activepieces/shared').HostedPlanId }): Promise<HostingGrant> {
    const grants = await manager.getRepository(HostingGrantEntity).find({ where: { platformId, meter }, order: { validFrom: 'DESC', id: 'ASC' } })
    const grant = grants.find(value => hostingGrantMatchesPlan(value, planId) && subscriptionGrantActive(account, value, now))
    if (!grant) hostingFail('HOSTING_GRANT_EXPIRED')
    return grant
}

async function findReservation({ manager, platformId, reservationId, kind }: { manager: EntityManager, platformId: string, reservationId: string, kind?: 'execution' | 'managed_ai' }): Promise<HostingReservation> {
    const value = await manager.getRepository(HostingReservationEntity).findOneBy({ id: reservationId, platformId, ...(kind ? { kind } : {}) })
    if (!value) hostingFail('HOSTING_RESERVATION_NOT_FOUND')
    return value
}

async function lockBudget({ manager, day, create }: { manager: EntityManager, day: string, create: boolean }) {
    if (create) await manager.getRepository(HostingDailyBudgetEntity).createQueryBuilder().insert().values({ id: day, reserved: 0n, consumed: 0n, limit: BigInt(hostingCatalog.dailyTrialOperatorCostLimitMicroUsd) }).orIgnore().execute()
    const value = await manager.getRepository(HostingDailyBudgetEntity).findOne({ where: { id: day }, lock: { mode: 'pessimistic_write' } })
    if (!value) hostingFail('HOSTING_BUDGET_NOT_FOUND')
    return value
}

async function release({ manager, reservation }: { manager: EntityManager, reservation: HostingReservation }): Promise<void> {
    const inclusive = hostedInclusiveCredits(reservation)
    const grant = await manager.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId, platformId: reservation.platformId })
    if (!inclusive) await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { reserved: grant.reserved - reservation.amount })
    if (reservation.kind === 'managed_ai') {
        const budget = await manager.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: requiredDay(reservation) })
        await manager.getRepository(HostingDailyBudgetEntity).update({ id: budget.id }, { reserved: budget.reserved - (reservation.supplierMaxMicroUsd ?? reservation.amount) })
    }
    else await manager.getRepository(HostingAccountEntity).decrement({ id: reservation.platformId }, 'activeExecutions', 1)
    await manager.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'released', actualAmount: 0n })
    if (inclusive) {
        const root = reservation.kind === 'execution' ? { ...reservation, state: 'released' as const, actualAmount: 0n } : await findReservation({ manager, platformId: reservation.platformId, reservationId: reservation.rootReservationId ?? '', kind: 'execution' })
        if (!hostedInclusiveCredits(root)) hostingFail('HOSTING_AI_ACCOUNTING_VERSION_INVALID')
        await reconcileHostedInclusiveCredits({ manager, root, key: `release:${reservation.id}` })
        if (reservation.kind === 'managed_ai') await tx.entry({ manager, reservation, operation: 'release', amount: 0n })
    }
    else {
        await tx.entry({ manager, reservation, operation: 'release', amount: reservation.amount })
        if (grant.revokedAt) await tx.entry({ manager, reservation, operation: 'revoke', amount: reservation.amount, key: `revoke-released:${reservation.id}` })
    }
}

function assertOwner({ actor, reservation }: { actor: HostingActor, reservation: HostingReservation }): void {
    if (reservation.identityId !== actor.identityId) hostingFail('HOSTING_ACCESS_DENIED')
}
function assertFence({ reservation, dispatchId }: { reservation: HostingReservation, dispatchId: string }): void {
    if (!dispatchId || reservation.dispatchId !== dispatchId) hostingFail('HOSTING_DISPATCH_FENCE_MISMATCH')
}
function requiredDay(reservation: HostingReservation): string {
    if (!reservation.day) hostingFail('HOSTING_BUDGET_NOT_FOUND'); return reservation.day
}
function utcDay(now: Date): string {
    return now.toISOString().slice(0, 10)
}
function maxZero(value: bigint): bigint {
    return value < 0n ? 0n : value
}
type Fence = { platformId: string, reservationId: string, dispatchId: string }
type Claim = { claimed: boolean, dispatchId: string | null }

function reservationCreditExposure(reservation: HostingReservation): bigint {
    if (reservation.state === 'released') return 0n
    const quantity = reservation.state === 'settled' ? reservation.actualAmount ?? reservation.amount : reservation.amount
    return hostedUsesCreditAccounting(reservation.accountingVersion) ? quantity : hostedAiCredits(quantity, reservation.microUsdPerCredit ?? HOSTED_LEGACY_MICRO_USD_PER_CREDIT)
}

export { lockBudget as lockHostedBudget }

// Coordinators reserve capacity and a provisional Credit before dispatch. Their
// confirmed completion costs zero; only delivered flow roots consume execution
// Credits. This classification is persisted server authority, never request data.
async function isConfirmedCoordinator({ manager, reservation }: { manager: EntityManager, reservation: HostingReservation }): Promise<boolean> {
    const root = await manager.getRepository(HostingDispatchEntity).findOneBy({ platformId: reservation.platformId, reservationId: reservation.id, rootDispatchId: IsNull() })
    if (!root?.payload || !isHostedCoordinatorJob(root.payload)) return false
    const segments = await manager.getRepository(HostingDispatchEntity).find({ where: [{ id: root.id, platformId: root.platformId }, { rootDispatchId: root.id, platformId: root.platformId }] })
    if (segments.some(segment => !segment.payload || !isHostedCoordinatorJob(segment.payload) || !['completed', 'cancelled'].includes(segment.state) || (segment.state === 'completed' && !hasDefinitiveHostedCompletion(segment.payload, segment.completionStatus)))) hostingFail('HOSTING_COORDINATOR_RECEIPT_REQUIRED')
    if (await manager.getRepository(HostingModelCallEntity).existsBy({ platformId: reservation.platformId, rootReservationId: reservation.id })) hostingFail('HOSTING_COORDINATOR_MODEL_DENIED')
    return true
}
