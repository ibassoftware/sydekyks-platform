import { apId } from '@activepieces/core-utils'
import { UserIdentityProvider } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { passwordHasher } from '../authentication/lib/password-hasher'
import { revokePasswordSessions } from '../authentication/password-service'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export async function setHostedUserPassword({ dataSource, actor, input }: { dataSource: DataSource, actor: HostingActor, input: { email: string, currentPassword: string, newPassword: string, reason: string } }): Promise<void> {
    const password = await passwordHasher.hash(input.newPassword)
    await tx.run({ dataSource, fn: async manager => {
        const email = input.email.trim().toLowerCase()
        const target = await manager.getRepository(UserIdentityEntity).findOneBy({ email })
        if (!target) hostingFail('HOSTING_RECOVERY_ACCOUNT_UNAVAILABLE')
        // Consistent lock order also permits an operator to change their own password.
        for (const id of [...new Set([actor.identityId, target.id])].sort()) await manager.getRepository(UserIdentityEntity).findOneOrFail({ where: { id }, lock: { mode: 'pessimistic_write' } })
        await assertHostingOperator({ manager, actor })
        const operator = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: actor.identityId })
        const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: target.id })
        if (operator.provider !== UserIdentityProvider.EMAIL || !await passwordHasher.compare(input.currentPassword, operator.password)) hostingFail('HOSTING_OPERATOR_REQUIRED')
        if (!identity.verified || identity.provider !== UserIdentityProvider.EMAIL || identity.email !== email) hostingFail('HOSTING_RECOVERY_ACCOUNT_UNAVAILABLE')
        await manager.getRepository(UserIdentityEntity).update(identity.id, { password, tokenVersion: apId() })
        await revokePasswordSessions(manager, identity.id)
        await tx.event({ manager, platformId: actor.platformId, event: 'identity.password.admin_changed', payload: { actorIdentityId: actor.identityId, identityId: identity.id, reason: input.reason } })
    } })
}
