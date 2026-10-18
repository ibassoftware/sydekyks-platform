import { apId } from '@activepieces/core-utils'
import { PlatformRole, UserIdentity, UserStatus } from '@activepieces/shared'
import { DataSource, EntityManager, In } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { McpOAuthTokenEntity } from '../mcp/oauth/token/mcp-oauth-token.entity'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { HostingAccessMembership, HostingAccessMembershipEntity, HostingAccessRole, HostingAccessRoleEntity } from './hosting-access-entities'
import { assertHostingOperator, hasOperationalAccess, isOperationalUser, operationalExternalId } from './hosting-access-policy'
import { HostingAccountEntity } from './hosting-entities'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

type AssignmentParams = { actor: HostingActor, platformId: string, identityId: string }
type RoleParams = { actor: HostingActor, identityId: string, role: HostingAccessRole['role'], active: boolean }
type EntryParams = { actor: HostingActor, platformId: string }
type OperationalTenant = { platformId: string, userId: string, projectId: string | null, tokenVersion: string | null }
type WorkspaceList = { platformId: string, userId: string, role: HostingAccessRole['role'] | null, workspaces: { platformId: string, name: string }[] }
type HostedAccessService = {
    setRole(params: RoleParams): Promise<void>
    assignPartner(params: AssignmentParams): Promise<HostingAccessMembership>
    unassignPartner(params: AssignmentParams): Promise<void>
    enter(params: EntryParams): Promise<OperationalTenant>
    list(params: { actor: HostingActor }): Promise<WorkspaceList>
}

export function createHostedAccess({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }): HostedAccessService {
    async function setRole({ actor, identityId, role, active }: RoleParams): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await lockIdentity(manager, identityId)
            const previous = await manager.getRepository(HostingAccessRoleEntity).findOneBy({ id: identityId })
            // Changing or revoking the global role invalidates all old operational memberships.
            if (previous && (previous.role !== role || !active)) {
                const memberships = await manager.getRepository(HostingAccessMembershipEntity).findBy({ identityId, active: true })
                for (const membership of memberships) await revokeMembership(manager, actor, membership)
            }
            await manager.getRepository(HostingAccessRoleEntity).save({ id: identityId, role, active })
            await tx.event({ manager, platformId: actor.platformId, event: 'operational.role.changed', payload: { actorIdentityId: actor.identityId, identityId, role, active } })
        } })
    }

    async function assignPartner({ actor, platformId, identityId }: AssignmentParams): Promise<HostingAccessMembership> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await lockIdentity(manager, identityId)
            await tx.account({ manager, platformId })
            const role = await manager.getRepository(HostingAccessRoleEntity).findOneBy({ id: identityId, role: 'partner', active: true })
            if (!role) hostingFail('HOSTING_PARTNER_REQUIRED')
            return materialize(manager, actor, platformId, role)
        } })
    }

    async function unassignPartner({ actor, platformId, identityId }: AssignmentParams): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await lockIdentity(manager, identityId)
            await tx.account({ manager, platformId })
            const membership = await manager.getRepository(HostingAccessMembershipEntity).findOneBy({ platformId, identityId, role: 'partner' })
            if (membership?.active) await revokeMembership(manager, actor, membership)
        } })
    }

    async function enter({ actor, platformId }: EntryParams): Promise<OperationalTenant> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const identity = await lockIdentity(manager, actor.identityId)
            if (actor.tokenVersion === undefined || (identity.tokenVersion ?? null) !== actor.tokenVersion) hostingFail('HOSTING_SESSION_EXPIRED')
            // Check the source session before looking at the requested client.
            await tx.member({ manager, actor })
            const account = await tx.account({ manager, platformId })
            const role = await manager.getRepository(HostingAccessRoleEntity).findOneBy({ id: actor.identityId, active: true })
            if (!role) hostingFail('HOSTING_OPERATIONAL_ACCESS_DENIED')
            // Preserve independent customer/home memberships instead of converting
            // an existing administrator into an operational service account.
            const independent = await manager.getRepository(UserEntity).findOneBy({ platformId, identityId: actor.identityId, status: UserStatus.ACTIVE })
            if (independent && !isOperationalUser(independent)) {
                await tx.member({ manager, actor: { ...actor, platformId } })
                await tx.event({ manager, platformId, event: 'operational.workspace.entered', payload: { actorIdentityId: actor.identityId, actorUserId: independent.id, role: role.role, access: 'existing_membership' } })
                return { platformId, userId: independent.id, projectId: null, tokenVersion: identity.tokenVersion ?? null }
            }
            const membership = role.role === 'team'
                ? await materialize(manager, actor, platformId, role)
                : await manager.getRepository(HostingAccessMembershipEntity).findOneBy({ platformId, identityId: actor.identityId, role: 'partner', active: true })
            if (!membership) hostingFail('HOSTING_OPERATIONAL_ACCESS_DENIED')
            const user = await manager.getRepository(UserEntity).findOneByOrFail({ id: membership.userId })
            if (!await hasOperationalAccess({ manager, user })) hostingFail('HOSTING_OPERATIONAL_ACCESS_DENIED')
            await tx.event({ manager, platformId, event: 'operational.workspace.entered', payload: { actorIdentityId: actor.identityId, actorUserId: user.id, role: role.role } })
            return { platformId, userId: user.id, projectId: account.initialProjectId, tokenVersion: identity.tokenVersion ?? null }
        } })
    }

    async function list({ actor }: { actor: HostingActor }): Promise<WorkspaceList> {
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            const user = await tx.member({ manager, actor })
            const role = await manager.getRepository(HostingAccessRoleEntity).findOneBy({ id: actor.identityId, active: true })
            if (!role) return { platformId: actor.platformId, userId: user.id, role: null, workspaces: [] }
            // Bounded operator pilot: no unbounded client list in a tenant-facing response.
            const rows = role.role === 'team'
                ? await manager.getRepository(HostingAccountEntity).find({ order: { created: 'DESC' }, take: 100 })
                : await manager.getRepository(HostingAccessMembershipEntity).find({ where: { identityId: actor.identityId, role: 'partner', active: true }, order: { created: 'DESC' }, take: 100 })
            const independent = role.role === 'partner' ? await manager.getRepository(UserEntity).find({ where: { identityId: actor.identityId, status: UserStatus.ACTIVE }, take: 100 }) : []
            const platformIds = [...new Set([
                ...rows.map(row => 'platformId' in row ? row.platformId : row.id),
                ...independent.filter(member => !isOperationalUser(member) && member.platformId).map(member => member.platformId as string),
            ])].slice(0, 100)
            const platforms = platformIds.length ? await manager.getRepository(PlatformEntity).findBy({ id: In(platformIds) }) : []
            return { platformId: actor.platformId, userId: user.id, role: role.role, workspaces: platforms.map(platform => ({ platformId: platform.id, name: platform.name })) }
        } })
    }
    return { setRole, assignPartner, unassignPartner, enter, list }
}

async function lockIdentity(manager: EntityManager, identityId: string): Promise<UserIdentity> {
    const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: identityId }, lock: { mode: 'pessimistic_write' } })
    if (!identity?.verified) hostingFail('HOSTING_VERIFIED_IDENTITY_REQUIRED')
    return identity
}

async function materialize(manager: EntityManager, actor: HostingActor, platformId: string, role: HostingAccessRole): Promise<HostingAccessMembership> {
    const memberships = manager.getRepository(HostingAccessMembershipEntity)
    const existing = await memberships.findOneBy({ platformId, identityId: role.id })
    const users = manager.getRepository(UserEntity)
    const user = await users.findOneBy({ platformId, identityId: role.id })
    // Never reinterpret an existing customer/owner membership as operational access.
    if (user && (!existing || existing.userId !== user.id || user.externalId !== operationalExternalId(role.id))) hostingFail('HOSTING_EXISTING_CLIENT_MEMBERSHIP')
    if (existing?.active && existing.role !== role.role) hostingFail('HOSTING_OPERATIONAL_ROLE_CONFLICT')
    const userId = existing?.userId ?? apId()
    await users.save({ id: userId, identityId: role.id, platformId, platformRole: PlatformRole.OPERATOR, status: UserStatus.ACTIVE, externalId: operationalExternalId(role.id) })
    const membership = await memberships.save({ id: existing?.id ?? apId(), platformId, identityId: role.id, userId, role: role.role, active: true })
    if (!existing?.active) await tx.event({ manager, platformId, event: 'operational.access.granted', payload: { actorIdentityId: actor.identityId, identityId: role.id, userId, role: role.role } })
    return membership
}

async function revokeMembership(manager: EntityManager, actor: HostingActor, membership: HostingAccessMembership): Promise<void> {
    await manager.getRepository(HostingAccessMembershipEntity).update({ id: membership.id }, { active: false })
    await manager.getRepository(UserEntity).update({ id: membership.userId, identityId: membership.identityId, platformId: membership.platformId }, { status: UserStatus.INACTIVE })
    await manager.getRepository(UserIdentityEntity).update({ id: membership.identityId }, { tokenVersion: apId() })
    await manager.getRepository(McpOAuthTokenEntity).update({ userId: membership.userId, platformId: membership.platformId }, { revoked: true })
    await tx.event({ manager, platformId: membership.platformId, event: 'operational.access.revoked', payload: { actorIdentityId: actor.identityId, identityId: membership.identityId, userId: membership.userId, role: membership.role } })
}
