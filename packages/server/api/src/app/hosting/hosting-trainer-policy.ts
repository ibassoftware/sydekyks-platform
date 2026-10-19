import { PlatformRole, User, UserStatus } from '@activepieces/shared'
import { EntityManager, In } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { HostingAccountEntity } from './hosting-entities'
import { identityAdmission } from './hosting-identity-admission'
import { HostingTrainerAssignmentEntity, HostingTrainerRoleEntity } from './hosting-trainer-entities'
import { HostingActor, hostingFail } from './hosting-transactions'

export const trainerExternalId = (identityId: string): string => `sydekyks-operational:trainer:${identityId}`
export async function isPrivilegedTrainerIdentity(manager: EntityManager, identityId: string): Promise<boolean> {
    return manager.getRepository(HostingTrainerRoleEntity).existsBy({ id: identityId })
}
// Write callers lock actor identity -> trainer role -> portfolio assignment,
// then enrollment/account. Removal uses that same actor/role fence; no role or
// assignment may be inferred from a browser claim or materialized user alone.
export async function currentPlatformTrainer({ manager, actor, lock = false }: { manager: EntityManager, actor: HostingActor, lock?: boolean }) {
    const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: actor.identityId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) })
    const user = await manager.getRepository(UserEntity).findOneBy({ identityId: actor.identityId, platformId: actor.platformId, status: UserStatus.ACTIVE })
    const trainer = await manager.getRepository(HostingTrainerRoleEntity).findOne({ where: { id: actor.identityId, active: true }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) })
    if (!identity?.verified || actor.tokenVersion === undefined || (identity.tokenVersion ?? null) !== actor.tokenVersion || !user || !trainer) return null
    if (user.externalId?.startsWith('sydekyks-operational:')) {
        if (user.externalId !== trainerExternalId(identity.id) || !await manager.getRepository(HostingTrainerAssignmentEntity).existsBy({ trainerIdentityId: identity.id, kind: 'client', clientPlatformId: actor.platformId, userId: user.id, active: true })) return null
    }
    return { user, trainer }
}
export async function assertPlatformTrainer(input: Parameters<typeof currentPlatformTrainer>[0]) {
    const value = await currentPlatformTrainer({ ...input, lock: input.lock ?? true })
    if (!value) hostingFail('HOSTING_TRAINER_REQUIRED')
    return value
}
export async function assertTrainerClient({ manager, actor, platformId }: { manager: EntityManager, actor: HostingActor, platformId: string }) {
    const authority = await assertPlatformTrainer({ manager, actor })
    const assignment = await manager.getRepository(HostingTrainerAssignmentEntity).findOne({ where: { trainerIdentityId: actor.identityId, kind: 'client', clientPlatformId: platformId, active: true }, lock: { mode: 'pessimistic_write' } })
    if (!assignment) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
    return { ...authority, assignment, platformId }
}
export async function assertTrainerRecipient({ manager, actor, identityId, audience, platformId }: { manager: EntityManager, actor: HostingActor, identityId: string, audience: 'partner' | 'end_user', platformId?: string }) {
    const authority = await assertPlatformTrainer({ manager, actor })
    if (identityId === actor.identityId) hostingFail('HOSTING_TRAINER_SELF_GRANT_DENIED')
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: identityId, verified: true })
    if (!identity) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
    const partner = await manager.getRepository(HostingTrainerAssignmentEntity).findOne({ where: { trainerIdentityId: actor.identityId, kind: 'partner', partnerIdentityId: identityId, active: true }, lock: { mode: 'pessimistic_write' } })
    if (partner && !platformId) return { ...authority, assignment: partner, identityId, platformId: null }
    if (audience === 'partner') hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
    const assignments = await manager.getRepository(HostingTrainerAssignmentEntity).find({ where: { trainerIdentityId: actor.identityId, kind: 'client', active: true, ...(platformId ? { clientPlatformId: platformId } : {}) }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } })
    for (const assignment of assignments) {
        const user = await manager.getRepository(UserEntity).findOneBy({ identityId, platformId: assignment.clientPlatformId!, status: UserStatus.ACTIVE })
        if (user && !user.externalId?.startsWith('sydekyks-operational:')) return { ...authority, assignment, identityId, platformId: assignment.clientPlatformId }
    }
    hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
}
export async function listTrainerClients({ manager, actor }: { manager: EntityManager, actor: HostingActor }) {
    await assertPlatformTrainer({ manager, actor })
    const assignments = await manager.getRepository(HostingTrainerAssignmentEntity).findBy({ trainerIdentityId: actor.identityId, kind: 'client', active: true })
    const result = []
    for (const assignment of assignments) {
        const platform = await manager.getRepository(PlatformEntity).findOneBy({ id: assignment.clientPlatformId! })
        if (platform) result.push({ platformId: platform.id, name: platform.name })
    }
    return result
}
export async function listTrainerLearners({ manager, actor, audience = 'end_user', platformId }: { manager: EntityManager, actor: HostingActor, audience?: 'partner' | 'end_user', platformId?: string }) {
    await assertPlatformTrainer({ manager, actor })
    const ids = new Set<string>()
    if (!platformId) for (const row of await manager.getRepository(HostingTrainerAssignmentEntity).findBy({ trainerIdentityId: actor.identityId, kind: 'partner', active: true })) if (row.partnerIdentityId) ids.add(row.partnerIdentityId)
    if (audience === 'end_user') for (const client of await listTrainerClients({ manager, actor })) {
        if (platformId && client.platformId !== platformId) continue
        for (const user of await manager.getRepository(UserEntity).findBy({ platformId: client.platformId, status: UserStatus.ACTIVE })) if (!user.externalId?.startsWith('sydekyks-operational:')) ids.add(user.identityId)
    }
    const scopedClientIds = (await listTrainerClients({ manager, actor })).map(client => client.platformId)
    const result = []
    for (const identityId of ids) {
        if (identityId === actor.identityId) continue
        const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: identityId, verified: true })
        if (!identity) continue
        const owned = scopedClientIds.length ? await manager.getRepository(HostingAccountEntity).findBy({ ownerIdentityId: identityId, id: In(scopedClientIds) }) : []
        const workspaces = []
        for (const account of owned) {
            const platform = await manager.getRepository(PlatformEntity).findOneBy({ id: account.id })
            if (platform) workspaces.push({ platformId: platform.id, name: platform.name, planId: account.planId })
        }
        result.push({ identityId, email: identity.email, firstName: identity.firstName, lastName: identity.lastName, verified: true, ...await identityAdmission(manager, identity), workspaces })
    }
    return result
}
export async function hasTrainerOperationalAccess({ manager, user }: { manager: EntityManager, user: User }): Promise<boolean> {
    if (!user.platformId || user.status !== UserStatus.ACTIVE || user.platformRole !== PlatformRole.OPERATOR || user.externalId !== trainerExternalId(user.identityId)) return false
    if (!await manager.getRepository(HostingTrainerRoleEntity).existsBy({ id: user.identityId, active: true })) return false
    return manager.getRepository(HostingTrainerAssignmentEntity).existsBy({ trainerIdentityId: user.identityId, kind: 'client', clientPlatformId: user.platformId, userId: user.id, active: true })
}

// Only the trainer's own newly-created, still-unclaimed recipient can use this
// internal provisioning path. It never claims an existing user's home/trial.
export async function assertTrainerProvisioning({ manager, actor, identityId, assignmentId }: { manager: EntityManager, actor: HostingActor, identityId: string, assignmentId: string }) {
    const authority = await assertPlatformTrainer({ manager, actor })
    const assignment = await manager.getRepository(HostingTrainerAssignmentEntity).findOne({ where: { id: assignmentId, trainerIdentityId: actor.identityId, kind: 'recipient', partnerIdentityId: identityId, active: true, provenance: 'onboarded', createdByIdentityId: actor.identityId }, lock: { mode: 'pessimistic_write' } })
    if (!assignment || identityId === actor.identityId || await manager.getRepository(UserEntity).existsBy({ identityId }) || await manager.getRepository(HostingAccountEntity).existsBy({ ownerIdentityId: identityId })) hostingFail('HOSTING_TRAINER_NEW_RECIPIENT_REQUIRED')
    return { ...authority, assignment }
}
