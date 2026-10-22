import { PlatformRole, User, UserStatus } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { z } from 'zod'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { UserEntity } from '../user/user-entity'
import { HostingAccessMembershipEntity, HostingAccessRoleEntity } from './hosting-access-entities'
import { HostingEligibilityEntity } from './hosting-entities'
import { partnerSubscriptionAllowed, subscriptionOperationalAllowed } from './hosting-subscription-policy'
import { hasTrainerOperationalAccess, trainerExternalId } from './hosting-trainer-policy'
import { HostingActor, hostingFail } from './hosting-transactions'

const OPERATIONAL_PREFIX = 'sydekyks-operational:'
export function operationalExternalId(identityId: string): string {
    return `${OPERATIONAL_PREFIX}${identityId}`
}
export function isOperationalUser(user: Pick<User, 'externalId'>): boolean {
    return user.externalId?.startsWith(OPERATIONAL_PREFIX) ?? false
}

// A role/assignment is authority; materialized tenant users alone are never authority.
export async function hasOperationalAccess({ manager, user }: { manager: EntityManager, user: User }): Promise<boolean> {
    if (!user.platformId || !await subscriptionOperationalAllowed(manager, user.platformId)) return false
    if (user.externalId === trainerExternalId(user.identityId)) return hasTrainerOperationalAccess({ manager, user })
    if (!isOperationalUser(user) || !user.platformId || user.externalId !== operationalExternalId(user.identityId) || user.status !== UserStatus.ACTIVE || ![PlatformRole.ADMIN, PlatformRole.OPERATOR].includes(user.platformRole)) return false
    const membership = await manager.getRepository(HostingAccessMembershipEntity).findOneBy({ userId: user.id, identityId: user.identityId, platformId: user.platformId, active: true })
    if (!membership || (user.platformRole === PlatformRole.ADMIN && membership.role !== 'partner') || (membership.role === 'partner' && !await partnerSubscriptionAllowed(manager, user.identityId))) return false
    return manager.getRepository(HostingAccessRoleEntity).existsBy({ id: user.identityId, role: membership.role, active: true })
}

export function hostingOperatorIdentityIds(): string[] {
    const raw = system.get(AppSystemProp.HOSTED_OPERATOR_IDENTITY_IDS)
    if (!raw?.trim()) return []
    const parsed = z.array(z.string().length(21)).max(100).safeParse(raw.split(',').map(value => value.trim()))
    return parsed.success ? parsed.data : []
}

export async function assertHostingOperator({ manager, actor }: { manager: EntityManager, actor: HostingActor }): Promise<User> {
    const user = await manager.getRepository(UserEntity).findOneBy({ identityId: actor.identityId, platformId: actor.platformId, status: UserStatus.ACTIVE, platformRole: PlatformRole.ADMIN })
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: actor.identityId })
    if (!user || isOperationalUser(user) || !identity?.verified || actor.tokenVersion === undefined || (identity.tokenVersion ?? null) !== actor.tokenVersion || !hostingOperatorIdentityIds().includes(identity.id)) hostingFail('HOSTING_OPERATOR_REQUIRED')
    return user
}

// Operational service accounts are not customer seats; their authority is checked
// separately and they cannot be created by client membership routes.
export async function hostedCustomerSeatCount(manager: EntityManager, platformId: string): Promise<number> {
    return manager.getRepository(UserEntity).createQueryBuilder('member')
        .where('member."platformId" = :platformId AND member.status = :status', { platformId, status: UserStatus.ACTIVE })
        .andWhere('(member."externalId" IS NULL OR member."externalId" NOT LIKE :prefix)', { prefix: `${OPERATIONAL_PREFIX}%` })
        .getCount()
}

/** Partner home membership stays single-user even before its package is funded. */
export async function hostedWorkspaceAllowsMembers(manager: EntityManager, account: { id: string, ownerIdentityId: string, planId: string }): Promise<boolean> {
    if (account.planId === 'training' || account.planId === 'assessment') return false
    const home = await manager.getRepository(HostingEligibilityEntity).existsBy({ identityId: account.ownerIdentityId, platformId: account.id })
    return !home || !await manager.getRepository(HostingAccessRoleEntity).existsBy({ id: account.ownerIdentityId, role: 'partner', active: true })
}
