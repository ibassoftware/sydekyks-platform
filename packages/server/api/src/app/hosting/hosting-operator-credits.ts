import { apId } from '@activepieces/core-utils'
import { hostingCatalog, PlatformRole, UserStatus } from '@activepieces/shared'
import { DataSource, EntityManager, Like } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { hostingOperatorIdentityIds, isOperationalUser } from './hosting-access-policy'
import { HostingAccount, HostingAccountEntity, HostingEligibilityEntity, HostingGrantEntity, HostingLedgerEntity, HostingOutboxEntity } from './hosting-entities'
import { HostingManualAccountEntity } from './hosting-manual-accounts-entities'
import { HostingStripeBindingEntity } from './hosting-stripe-entities'
import { HostingSubscriptionEntity } from './hosting-subscription-entities'
import { hostingMonthAnniversary } from './hosting-training-periods'

export const HOSTED_OPERATOR_MONTHLY_CREDITS = 100_000
const PREFIX = 'operator:'

export async function hasOperatorCreditFunding(manager: EntityManager, platformId: string): Promise<boolean> {
    return manager.getRepository(HostingGrantEntity).existsBy({ platformId, sourceKey: Like(`${PREFIX}%`) })
}

// Enrollment is an explicit installation-startup operation, not a side effect of
// an operator viewing a customer. Existing manual/Stripe terms are never adopted.
export async function initializeHostedOperatorCredits(dataSource: DataSource): Promise<void> {
    for (const identityId of hostingOperatorIdentityIds()) {
        await dataSource.transaction(async manager => {
            const home = await manager.getRepository(HostingEligibilityEntity).findOneBy({ identityId })
            if (!home) return
            const account = await manager.getRepository(HostingAccountEntity).findOne({ where: { id: home.platformId, ownerIdentityId: identityId }, lock: { mode: 'pessimistic_write' } })
            if (account) await synchronizeHostedOperatorCredits(manager, account, true)
        })
    }
}

// Callers hold the account lock. One immutable source per UTC month anniversary
// prevents double refills across API workers. Old grants/holds remain historical.
export async function synchronizeHostedOperatorCredits(manager: EntityManager, account: HostingAccount, enroll = false): Promise<HostingAccount> {
    const prior = await manager.getRepository(HostingGrantEntity).findOne({ where: { platformId: account.id, sourceKey: Like(`${PREFIX}%`), meter: 'execution' }, order: { validFrom: 'DESC' } })
    if (!prior && !enroll) return account
    if ((!prior && account.planId !== 'trial') || (prior && account.planId !== 'team') || account.status === 'suspended' || account.billingHold) return account
    const identity = hostingOperatorIdentityIds().includes(account.ownerIdentityId) ? await manager.getRepository(UserIdentityEntity).findOneBy({ id: account.ownerIdentityId, verified: true }) : null
    const user = identity ? await manager.getRepository(UserEntity).findOneBy({ identityId: identity.id, platformId: account.id, status: UserStatus.ACTIVE, platformRole: PlatformRole.ADMIN }) : null
    const eligible = user && !isOperationalUser(user)
        && await manager.getRepository(PlatformEntity).existsBy({ id: account.id, ownerId: user.id })
        && await manager.getRepository(HostingEligibilityEntity).existsBy({ identityId: account.ownerIdentityId, platformId: account.id })
    if (!eligible) {
        if (prior) {
            await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { status: 'suspended' })
            return { ...account, status: 'suspended' }
        }
        return account
    }
    // Never override an independently funded account or an explicit expiration policy.
    if (await manager.getRepository(HostingManualAccountEntity).existsBy({ id: account.id })
        || await manager.getRepository(HostingStripeBindingEntity).existsBy({ platformId: account.id })
        || await manager.getRepository(HostingSubscriptionEntity).existsBy({ id: account.id })) return account
    if (prior && account.validUntil.getTime() !== prior.validUntil.getTime()) return account
    const [{ now }] = await manager.query<{ now: Date }[]>('SELECT clock_timestamp() AS now')
    const period = hostedOperatorCreditPeriod(account.trialStartedAt, now)
    const sourceKey = `${PREFIX}${account.ownerIdentityId}:${period.from.toISOString()}`
    if (prior?.sourceKey === sourceKey) return account
    if (prior && (prior.revokedAt || prior.validFrom > now)) return account
    for (const [meter, amount] of [['execution', BigInt(HOSTED_OPERATOR_MONTHLY_CREDITS)], ['managed_ai', 0n]] as const) {
        const grantId = apId()
        await manager.getRepository(HostingGrantEntity).insert({ id: grantId, platformId: account.id, sourceKey, meter, amount, reserved: 0n, consumed: 0n, validFrom: period.from, validUntil: period.until })
        await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId, reservationId: null, operation: 'grant', key: `grant:${grantId}`, amount })
    }
    // Reuse Growth's resource ceilings internally; this is not a paid subscription,
    // Stripe record or a change to any public offer. Billing identifies platform_admin.
    const next = { ...account, planId: 'team' as const, status: 'active' as const, validUntil: period.until, catalogVersion: hostingCatalog.version }
    await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { planId: next.planId, status: next.status, validUntil: next.validUntil, catalogVersion: next.catalogVersion })
    await manager.getRepository(HostingOutboxEntity).insert({ id: apId(), platformId: account.id, event: 'operator.credits_issued', payload: { identityId: account.ownerIdentityId, sourceKey, monthlyCredits: HOSTED_OPERATOR_MONTHLY_CREDITS, validFrom: period.from.toISOString(), validUntil: period.until.toISOString() }, processedAt: null })
    return next
}

export function hostedOperatorCreditPeriod(anchor: Date, now: Date): { from: Date, until: Date } {
    let month = Math.max(0, (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth())
    if (hostingMonthAnniversary(anchor, month) > now && month > 0) month--
    return { from: hostingMonthAnniversary(anchor, month), until: hostingMonthAnniversary(anchor, month + 1) }
}
