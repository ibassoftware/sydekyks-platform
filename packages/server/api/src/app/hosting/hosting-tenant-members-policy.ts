import { PlatformRole, UserStatus } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { UserEntity } from '../user/user-entity'
import { HostingAccessRoleEntity } from './hosting-access-entities'
import { hasOperationalAccess, hostingOperatorIdentityIds, isOperationalUser } from './hosting-access-policy'
import { HostingAccountEntity } from './hosting-entities'
import { HostingActor, hostingFail } from './hosting-transactions'

export async function assertTenantAdministrator({ manager, actor }: { manager: EntityManager, actor: HostingActor }) {
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: actor.identityId })
    const user = await manager.getRepository(UserEntity).findOneBy({ identityId: actor.identityId, platformId: actor.platformId, status: UserStatus.ACTIVE, platformRole: PlatformRole.ADMIN })
    if (!identity?.verified || actor.tokenVersion === undefined || (identity.tokenVersion ?? null) !== actor.tokenVersion || !user || (isOperationalUser(user) && !await hasOperationalAccess({ manager, user })) || !await manager.getRepository(HostingAccountEntity).existsBy({ id: actor.platformId })) hostingFail('HOSTING_TENANT_ADMIN_REQUIRED')
    return user
}
export async function assertTenantMemberTarget({ manager, identityId, actorIdentityId }: { manager: EntityManager, identityId: string, actorIdentityId: string }) {
    if (identityId === actorIdentityId || hostingOperatorIdentityIds().includes(identityId) || await manager.getRepository(HostingAccessRoleEntity).existsBy({ id: identityId, role: 'team' })) hostingFail('HOSTING_MEMBER_PROTECTED')
}
