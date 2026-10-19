import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { HostedSubscriptionUpdate, HostedSubscriptionView } from '@activepieces/shared'
import { DataSource, EntityManager } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { PlatformEntity } from '../platform/platform.entity'
import { assertHostingOperator } from './hosting-access-policy'
import { HostingAccount } from './hosting-entities'
import { HostingSubscriptionCommandEntity, HostingSubscriptionEntity } from './hosting-subscription-entities'
import { lastFundedSubscriptionPeriod, loadSubscriptionContext, subscriptionAccountUntil, subscriptionDisableAt } from './hosting-subscription-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

async function view(manager: EntityManager, actor: HostingActor, account: HostingAccount): Promise<HostedSubscriptionView> {
    const operator = await assertHostingOperator({ manager, actor })
    const now = await tx.now(manager), context = await loadSubscriptionContext(manager, account), policy = context.policy
    const candidate = await lastFundedSubscriptionPeriod(manager, account)
    const disableAt = policy ? subscriptionDisableAt(policy) : null
    const state = !context.bindingValid ? 'review_required' : !policy?.renewalDueAt ? 'unmanaged' : now >= disableAt! ? 'overdue' : now >= policy.renewalDueAt ? 'grace' : 'current'
    const platform = await manager.getRepository(PlatformEntity).findOneByOrFail({ id: account.id })
    return HostedSubscriptionView.parse({
        platformId: actor.platformId, userId: operator.id, scopePlatformId: account.id, name: platform.name,
        planId: account.planId, accountStatus: account.status, billingHold: account.billingHold ?? false, revision: context.revision, origin: context.origin, serverTime: now.toISOString(),
        renewalDueAt: policy?.renewalDueAt?.toISOString() ?? null, graceEndsAt: disableAt?.toISOString() ?? null,
        state, effectiveRuntimeUntil: subscriptionAccountUntil({ ...account, subscription: context }).toISOString(),
        canManage: candidate !== null, limitation: !candidate ? 'funded_entitlement_required' : !context.bindingValid ? 'entitlement_changed' : null,
        boundPeriod: policy ? { sourceKey: policy.sourceKey, planId: policy.planId, validFrom: policy.validFrom.toISOString(), originalValidUntil: policy.originalValidUntil.toISOString(), executionGrantId: policy.executionGrantId, managedAiGrantId: policy.managedAiGrantId } : null,
    })
}

export function createHostedSubscriptions({ dataSource }: { dataSource: DataSource }) {
    async function read({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            return view(manager, actor, await tx.account({ manager, platformId }))
        } })
    }
    async function update({ actor, input }: { actor: HostingActor, input: HostedSubscriptionUpdate }) {
        const value = HostedSubscriptionUpdate.parse(input), payloadHash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
        return tx.run({ dataSource, fn: async manager => {
            // Actor identity -> target account is the command lock order. Runtime
            // and accounting already serialize on the target account lock.
            await manager.getRepository(UserIdentityEntity).findOne({ where: { id: actor.identityId }, lock: { mode: 'pessimistic_write' } })
            await assertHostingOperator({ manager, actor })
            const account = await tx.account({ manager, platformId: value.platformId })
            const previous = await manager.getRepository(HostingSubscriptionCommandEntity).findOneBy({ actorIdentityId: actor.identityId, requestKey: value.requestKey })
            if (previous) {
                if (previous.platformId !== account.id || previous.payloadHash !== payloadHash) hostingFail('HOSTING_SUBSCRIPTION_IDEMPOTENCY_CONFLICT')
                return view(manager, actor, account)
            }
            const policy = await manager.getRepository(HostingSubscriptionEntity).findOneBy({ id: account.id })
            if ((policy?.revision ?? 0) !== value.expectedRevision) hostingFail('HOSTING_SUBSCRIPTION_REVISION_CONFLICT')
            const binding = value.renewalDueAt ? await lastFundedSubscriptionPeriod(manager, account) : policy
            if (!binding) hostingFail('HOSTING_SUBSCRIPTION_FUNDED_ENTITLEMENT_REQUIRED')
            const due = value.renewalDueAt ? new Date(value.renewalDueAt) : null
            if (due && (due.getTime() < Date.parse('2000-01-01T00:00:00Z') || due.getTime() > Date.parse('9998-12-01T00:00:00Z'))) hostingFail('HOSTING_SUBSCRIPTION_INVALID_DATE')
            const revision = (policy?.revision ?? 0) + 1
            const saved = await manager.getRepository(HostingSubscriptionEntity).save({ ...binding, id: account.id, revision, renewalDueAt: due })
            const snapshot = { planId: saved.planId, entitlementId: saved.entitlementId, sourceKey: saved.sourceKey, accountValidUntil: saved.accountValidUntil.toISOString(), validFrom: saved.validFrom.toISOString(), originalValidUntil: saved.originalValidUntil.toISOString(), executionGrantId: saved.executionGrantId, managedAiGrantId: saved.managedAiGrantId, renewalDueAt: due?.toISOString() ?? null, graceEndsAt: subscriptionDisableAt(saved)?.toISOString() ?? null }
            await manager.getRepository(HostingSubscriptionCommandEntity).save({ id: apId(), platformId: account.id, actorIdentityId: actor.identityId, requestKey: value.requestKey, payloadHash, revision, reason: value.reason, snapshot })
            await tx.event({ manager, platformId: account.id, event: 'subscription.override.changed', payload: { actorIdentityId: actor.identityId, revision, reason: value.reason, ...snapshot } })
            return view(manager, actor, account)
        } })
    }
    return { read, update }
}
