import { EntityManager, In } from 'typeorm'
import { HostingAccount, HostingAccountEntity, HostingEligibilityEntity, HostingGrant, HostingGrantEntity } from './hosting-entities'
import { hostingGrantMatchesPlan } from './hosting-plan-grants'
import { HostingStripePeriodEntity } from './hosting-stripe-entities'
import { HostingSubscription, HostingSubscriptionContext, HostingSubscriptionEntity } from './hosting-subscription-entities'
import { fundedTrainingPeriods } from './hosting-training-periods'
import { HostingTrainingEntity } from './hosting-training-entity'

export type SubscriptionPeriodBinding = Omit<HostingSubscription, 'id' | 'created' | 'updated' | 'revision' | 'renewalDueAt'>
const same = (a: Date, b: Date) => a.getTime() === b.getTime()

// Only server-verified funding provenance may bind remaining credits. Core/Launch
// preissue future periods, so bind the LAST period but never move its validFrom.
export async function lastFundedSubscriptionPeriod(manager: EntityManager, account: HostingAccount): Promise<SubscriptionPeriodBinding | null> {
    let binding: Omit<SubscriptionPeriodBinding, 'executionGrantId' | 'managedAiGrantId'> | null = null
    if (account.planId === 'training') {
        const training = await manager.getRepository(HostingTrainingEntity).findOneBy({ platformId: account.id, identityId: account.ownerIdentityId })
        if (!training || training.revokedAt || !same(training.endsAt, account.validUntil)) return null
        const periods = fundedTrainingPeriods(training)
        if (!periods) return null
        const last = periods.length - 1
        binding = { planId: 'training', entitlementId: training.id, sourceKey: `training:${training.id}:${last}`, accountValidUntil: account.validUntil, validFrom: periods[last].from, originalValidUntil: training.endsAt }
    }
    else if (account.planId === 'starter' || account.planId === 'team' || account.planId === 'scale') {
        const periods = await manager.getRepository(HostingStripePeriodEntity).find({ where: { platformId: account.id, planId: account.planId }, order: { periodEnd: 'DESC', id: 'ASC' }, take: 1 })
        const period = periods[0]
        if (!period || period.revokedAt || !period.sourceKey.startsWith('stripe:') || !same(period.periodEnd, account.validUntil)) return null
        binding = { planId: account.planId, entitlementId: period.id, sourceKey: period.sourceKey, accountValidUntil: account.validUntil, validFrom: period.periodStart, originalValidUntil: period.periodEnd }
    }
    if (!binding) return null
    const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId: account.id, sourceKey: binding.sourceKey })
    const execution = grants.find(grant => grant.meter === 'execution'), managed = grants.find(grant => grant.meter === 'managed_ai')
    if (!execution || !managed || grants.length !== 2 || [execution, managed].some(grant => grant.revokedAt || !same(grant.validFrom, binding!.validFrom) || !same(grant.validUntil, binding!.originalValidUntil))) return null
    return { ...binding, executionGrantId: execution.id, managedAiGrantId: managed.id }
}

export const SUBSCRIPTION_GRACE_MS = 15 * 86_400_000
export const subscriptionDisableAt = (policy: HostingSubscription): Date | null => policy.renewalDueAt ? new Date(policy.renewalDueAt.getTime() + SUBSCRIPTION_GRACE_MS) : null

// Funded Starter/Team periods have a read-only due+15day default. Fixed Core,
// trial and assessment windows stay unchanged unless an eligible operator
// explicitly overrides them. Every bound source is reverified on each read;
// explicit overrides never migrate across plan changes or revive revoked funds.
export async function loadSubscriptionContext(manager: EntityManager, account: HostingAccount): Promise<HostingSubscriptionContext> {
    const stored = await manager.getRepository(HostingSubscriptionEntity).findOneBy({ id: account.id })
    const revision = stored?.revision ?? 0
    let policy = stored
    let origin: HostingSubscriptionContext['origin'] = 'override'
    if (!policy?.renewalDueAt) {
        if (account.planId !== 'starter' && account.planId !== 'team' && account.planId !== 'scale') return { policy: null, bindingValid: true, revision, origin: 'fixed' }
        origin = 'paid_default'
        const bound = await lastFundedSubscriptionPeriod(manager, account)
        if (!bound) return { policy: null, bindingValid: true, revision, origin: 'fixed' }
        policy = { ...bound, id: account.id, created: account.created, updated: account.updated, revision, renewalDueAt: account.validUntil }
    }
    const context = { policy, revision, origin }

    if (account.planId !== policy.planId || !same(account.validUntil, policy.accountValidUntil)) return { ...context, bindingValid: false }
    const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId: account.id, id: In([policy.executionGrantId, policy.managedAiGrantId]) })
    const execution = grants.find(grant => grant.id === policy.executionGrantId && grant.meter === 'execution')
    const managed = grants.find(grant => grant.id === policy.managedAiGrantId && grant.meter === 'managed_ai')
    const pairValid = [execution, managed].every(grant => grant && !grant.revokedAt && grant.sourceKey === policy.sourceKey && same(grant.validFrom, policy.validFrom) && same(grant.validUntil, policy.originalValidUntil))
    if (!pairValid) return { ...context, bindingValid: false }
    if (policy.planId === 'training') {
        const training = await manager.getRepository(HostingTrainingEntity).findOneBy({ id: policy.entitlementId, platformId: account.id, identityId: account.ownerIdentityId })
        const periods = training ? fundedTrainingPeriods(training) : null
        const last = periods ? periods.length - 1 : -1
        return { ...context, bindingValid: !!training && !!periods && !training.revokedAt && same(training.endsAt, policy.accountValidUntil) && same(policy.validFrom, periods[last].from) && same(policy.originalValidUntil, training.endsAt) && policy.sourceKey === `training:${training.id}:${last}` }
    }
    const period = await manager.getRepository(HostingStripePeriodEntity).findOneBy({ id: policy.entitlementId, platformId: account.id, planId: policy.planId, sourceKey: policy.sourceKey })
    return { ...context, bindingValid: !!period && !period.revokedAt && same(period.periodStart, policy.validFrom) && same(period.periodEnd, policy.originalValidUntil) && same(period.periodEnd, policy.accountValidUntil) }
}
export function subscriptionAccountUntil(account: HostingAccount): Date {
    const context = account.subscription
    if (context && !context.bindingValid) return new Date(0)
    if (!context?.policy?.renewalDueAt) return account.validUntil
    return context.bindingValid ? subscriptionDisableAt(context.policy)! : new Date(0)
}
export function subscriptionAccountActive(account: HostingAccount, now: Date): boolean {
    return account.status !== 'suspended' && !account.billingHold && subscriptionAccountUntil(account) > now
}
export function subscriptionGrantUntil(account: HostingAccount, grant: HostingGrant): Date {
    const context = account.subscription, policy = context?.policy
    if (!policy?.renewalDueAt || !context?.bindingValid || ![policy.executionGrantId, policy.managedAiGrantId].includes(grant.id) || grant.sourceKey !== policy.sourceKey || grant.platformId !== account.id) return grant.validUntil
    return new Date(Math.max(grant.validUntil.getTime(), subscriptionDisableAt(policy)!.getTime()))
}
export function subscriptionGrantActive(account: HostingAccount, grant: HostingGrant, now: Date): boolean {
    return hostingGrantMatchesPlan(grant, account.planId) && !grant.revokedAt && grant.validFrom <= now && subscriptionGrantUntil(account, grant) > now
}

// Current read only: never back-lock a Partner home account while holding a
// client account lock. Every project/runtime authorization rechecks this policy;
// accounting commits already sent remain settleable after a cutoff.
export async function subscriptionOperationalAllowed(manager: EntityManager, platformId: string): Promise<boolean> {
    const account = await manager.getRepository(HostingAccountEntity).findOneBy({ id: platformId })
    if (!account || account.status === 'suspended' || account.billingHold) return false
    const context = await loadSubscriptionContext(manager, account)
    if (!context.bindingValid) return false
    if (!context.policy?.renewalDueAt) return true
    const [{ now }] = await manager.query<{ now: Date }[]>('SELECT clock_timestamp() AS now')
    return subscriptionAccountActive({ ...account, subscription: context }, now)
}
export async function partnerSubscriptionAllowed(manager: EntityManager, identityId: string): Promise<boolean> {
    const home = await manager.getRepository(HostingEligibilityEntity).findOneBy({ identityId })
    return !home || subscriptionOperationalAllowed(manager, home.platformId)
}
