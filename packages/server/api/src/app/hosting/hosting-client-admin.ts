import { createHash } from 'node:crypto'
import { hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager } from 'typeorm'
import { z } from 'zod'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { PlatformEntity } from '../platform/platform.entity'
import { HostingAccessMembershipEntity } from './hosting-access-entities'
import { assertHostingOperator } from './hosting-access-policy'
import { hostedPlanLimits } from './hosting-concurrency'
import { HostingAccount, HostingAccountEntity } from './hosting-entities'
import { HostingManualAccountEntity } from './hosting-manual-accounts-entities'
import { subscriptionAccountUntil } from './hosting-subscription-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'
import { readHostedCredits } from './hosting-usage'

export const ClientProfileInput = z.strictObject({
    name: z.string().trim().min(1).max(120),
    expectedState: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(3).max(500),
    confirmed: z.literal(true),
})

export function hostedAccountKind(planId: string): 'client' | 'partner' | 'trial' {
    return planId === 'training' || planId === 'assessment' ? 'partner' : planId === 'trial' ? 'trial' : 'client'
}
export function clientProfileState(platformId: string, name: string): string {
    return createHash('sha256').update(JSON.stringify({ platformId, name })).digest('hex')
}

export function createHostedClientAdmin({ dataSource }: { dataSource: DataSource }) {
    async function read({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            const operator = await assertHostingOperator({ manager, actor })
            const account = await clientAccount(manager, platformId)
            return { platformId: actor.platformId, userId: operator.id, client: await view(manager, account) }
        } })
    }
    async function rename({ actor, platformId, input }: { actor: HostingActor, platformId: string, input: z.input<typeof ClientProfileInput> }) {
        const value = ClientProfileInput.parse(input)
        return tx.run({ dataSource, fn: async manager => {
            const operator = await assertHostingOperator({ manager, actor })
            const account = await clientAccount(manager, platformId)
            const platform = await manager.getRepository(PlatformEntity).findOne({ where: { id: platformId }, lock: { mode: 'pessimistic_write' } })
            if (!platform) hostingFail('HOSTING_CLIENT_UNAVAILABLE')
            if (value.expectedState !== clientProfileState(platformId, platform.name)) hostingFail('HOSTING_CLIENT_REVISION_CONFLICT')
            if (platform.name !== value.name) {
                await manager.getRepository(PlatformEntity).update({ id: platformId }, { name: value.name })
                await tx.event({ manager, platformId, event: 'client.profile.updated', payload: { operatorIdentityId: actor.identityId, previousName: platform.name, name: value.name, reason: value.reason } })
            }
            return { platformId: actor.platformId, userId: operator.id, client: await view(manager, account) }
        } })
    }
    return { read, rename }
}

async function clientAccount(manager: EntityManager, platformId: string) {
    const account = await manager.getRepository(HostingAccountEntity).findOneBy({ id: platformId })
    if (!account || hostedAccountKind(account.planId) !== 'client') hostingFail('HOSTING_CLIENT_UNAVAILABLE')
    return tx.account({ manager, platformId })
}
async function view(manager: EntityManager, account: HostingAccount) {
    const platform = await manager.getRepository(PlatformEntity).findOneByOrFail({ id: account.id })
    const owner = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: account.ownerIdentityId })
    const manual = await manager.getRepository(HostingManualAccountEntity).findOneBy({ id: account.id })
    const memberships = await manager.getRepository(HostingAccessMembershipEntity).findBy({ platformId: account.id, role: 'partner', active: true })
    const partners = []
    for (const membership of memberships) {
        const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: membership.identityId })
        if (identity) partners.push({ identityId: identity.id, name: `${identity.firstName} ${identity.lastName}`.trim(), email: identity.email })
    }
    return {
        platformId: account.id, name: platform.name, stateHash: clientProfileState(account.id, platform.name),
        owner: { identityId: owner.id, name: `${owner.firstName} ${owner.lastName}`.trim(), email: owner.email },
        planId: account.planId, status: account.status, validUntil: subscriptionAccountUntil(account).toISOString(),
        funding: manual ? 'manual' as const : account.subscription?.bindingValid ? 'stripe' as const : 'unconfirmed' as const,
        limits: { users: hostingCatalog.getPlan({ planId: account.planId }).users, concurrency: hostedPlanLimits(account.planId).concurrency },
        credits: await readHostedCredits(manager, account, await tx.now(manager)), partners,
    }
}
