import { ActivepiecesError, apId, ErrorCode } from '@activepieces/core-utils'
import { PlatformRole, UserIdentityProvider, UserStatus } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { passwordHasher } from '../../authentication/lib/password-hasher'
import { revokePasswordSessions } from '../../authentication/password-service'
import { UserIdentityEntity } from '../../authentication/user-identity/user-identity-entity'
import { UserEntity } from '../user-entity'

export async function setPlatformUserPassword({ dataSource, userId, platformId, tokenVersion, targetUserId, currentPassword, newPassword }: { dataSource: DataSource, userId: string, platformId: string, tokenVersion: string | null, targetUserId: string, currentPassword: string, newPassword: string }): Promise<void> {
    const deny = (): never => {
        throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} }) 
    }
    const password = await passwordHasher.hash(newPassword)
    await dataSource.transaction(async manager => {
        const users = manager.getRepository(UserEntity)
        const actor = await users.findOneBy({ id: userId, platformId, platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE })
        const target = await users.findOneBy({ id: targetUserId, platformId })
        if (!actor || !target) deny()
        for (const id of [...new Set([actor!.identityId, target!.identityId])].sort()) await manager.getRepository(UserIdentityEntity).findOneOrFail({ where: { id }, lock: { mode: 'pessimistic_write' } })
        const operator = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: actor!.identityId })
        const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: target!.identityId })
        if (!operator.verified || operator.provider !== UserIdentityProvider.EMAIL || (operator.tokenVersion ?? null) !== tokenVersion || !await passwordHasher.compare(currentPassword, operator.password)) deny()
        if (!identity.verified || identity.provider !== UserIdentityProvider.EMAIL) deny()
        // A tenant administrator cannot replace a global credential shared with
        // another installation tenant. Hosted operators have a separate audited route.
        const memberships = await users.findBy({ identityId: identity.id })
        if (memberships.some(user => user.platformId !== platformId)) deny()
        await manager.getRepository(UserIdentityEntity).update(identity.id, { password, tokenVersion: apId() })
        await revokePasswordSessions(manager, identity.id)
    })
}
