import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { UserStatus } from '@activepieces/shared'
import { DataSource, EntityManager } from 'typeorm'
import { z } from 'zod'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { createHostedAccess } from './hosting-access'
import { HostingAccessMembershipEntity, HostingAccessRoleEntity } from './hosting-access-entities'
import { assertHostingOperator, hostingOperatorIdentityIds, isOperationalUser } from './hosting-access-policy'
import { HostingAccountEntity } from './hosting-entities'
import { identityAdmission } from './hosting-identity-admission'
import { HostingManualAccountEntity } from './hosting-manual-accounts-entities'
import { HostingPartnerAdminBindingEntity, HostingPartnerAdminCommandEntity } from './hosting-partner-admin-entities'
import { HostingTrainingEntity } from './hosting-training-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const id = z.string().length(21)
export const PartnerDirectoryInput = z.strictObject({ after: id.optional(), search: z.string().trim().max(120).optional(), status: z.enum(['all', 'active', 'pending', 'inactive']).default('all') })
export const PartnerDecisionInput = z.strictObject({
    expectedRevision: z.number().int().min(0).max(1000), expectedState: z.string().regex(/^[a-f0-9]{64}$/),
    requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), active: z.boolean(),
})
export const PartnerAssignmentInput = PartnerDecisionInput.omit({ active: true }).extend({ platformId: id, assigned: z.boolean() }).strict()
type Onboarding = { provision(input: { identityId: string, name: string, operator: HostingActor, manager: EntityManager }): Promise<unknown> }
type Mutation = { actor: HostingActor, identityId: string, input: z.infer<typeof PartnerDecisionInput> | z.infer<typeof PartnerAssignmentInput> }

export function createHostedPartnerAdmin({ dataSource, onboarding }: { dataSource: DataSource, onboarding: Onboarding }) {
    async function lookup({ actor, email }: { actor: HostingActor, email: string }) {
        return tx.run({ dataSource, fn: async manager => {
            const operator = await assertHostingOperator({ manager, actor })
            const identity = await manager.getRepository(UserIdentityEntity).createQueryBuilder('identity')
                .where('LOWER(identity.email) = :email', { email: email.trim().toLowerCase() }).getOne()
            return { platformId: actor.platformId, userId: operator.id, candidate: identity ? await view(manager, actor, identity.id) : null }
        } })
    }
    async function list({ actor, ...input }: { actor: HostingActor } & z.input<typeof PartnerDirectoryInput>) {
        const { after, search, status } = PartnerDirectoryInput.parse(input)
        return tx.run({ dataSource, fn: async manager => {
            const operator = await assertHostingOperator({ manager, actor })
            const query = manager.getRepository(UserIdentityEntity).createQueryBuilder('identity')
                .leftJoin(HostingAccessRoleEntity.options.name, 'access_role', 'access_role.id = identity.id')
                .leftJoin(HostingManualAccountEntity.options.name, 'manual', 'manual."identityId" = identity.id AND manual.kind = :partner', { partner: 'partner' })
                .leftJoin(HostingTrainingEntity.options.name, 'training', 'training."identityId" = identity.id')
                .leftJoin(HostingAccountEntity.options.name, 'home', 'home."ownerIdentityId" = identity.id')
                .leftJoin(PlatformEntity.options.name, 'company', 'company.id = home.id')
                .where('(access_role.role = :partner OR manual.id IS NOT NULL OR training.id IS NOT NULL)', { partner: 'partner' })
                .andWhere('(access_role.role IS NULL OR access_role.role = :partner)', { partner: 'partner' })
            const protectedIds = hostingOperatorIdentityIds()
            if (protectedIds.length) query.andWhere('identity.id NOT IN (:...protectedIds)', { protectedIds })
            if (search) query.andWhere('POSITION(LOWER(:search) IN LOWER(CONCAT_WS(\' \', identity.email, identity."firstName", identity."lastName", company.name))) > 0', { search })
            if (status === 'active' || status === 'inactive') query.andWhere('access_role.role = :partner AND access_role.active = :active', { partner: 'partner', active: status === 'active' })
            if (status === 'pending') query.andWhere('access_role.id IS NULL')
            const total = await query.clone().getCount()
            if (after) query.andWhere('identity.id > :after', { after })
            const identities = await query.orderBy('identity.id', 'ASC').take(26).getMany()
            return { platformId: actor.platformId, userId: operator.id, total, partners: await Promise.all(identities.slice(0, 25).map(identity => view(manager, actor, identity.id))), next: identities.length > 25 ? identities[24].id : null }
        } })
    }
    async function mutate({ actor, identityId, input }: Mutation) {
        const assignment = 'assigned' in input
        const parsed = assignment ? PartnerAssignmentInput.parse(input) : PartnerDecisionInput.parse(input)
        const action = assignment ? (input.assigned ? 'assign' : 'unassign') : (input.active ? 'approve' : 'deactivate')
        const platformId = assignment ? input.platformId : null
        const payloadHash = hash({ identityId, action, input: parsed })
        try {
            return await tx.run({ dataSource, fn: async manager => {
                let operator = await assertHostingOperator({ manager, actor })
                // Same target-identity -> client-account ordering as the existing
                // operational access service. Nested services share this transaction.
                const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: identityId }, lock: { mode: 'pessimistic_write' } })
                if (!identity?.verified) hostingFail('HOSTING_VERIFIED_IDENTITY_REQUIRED')
                const role = await manager.getRepository(HostingAccessRoleEntity).findOneBy({ id: identityId })
                if (identityId === actor.identityId || hostingOperatorIdentityIds().includes(identityId) || role?.role === 'team') hostingFail('HOSTING_PARTNER_IDENTITY_PROTECTED')
                const commands = manager.getRepository(HostingPartnerAdminCommandEntity)
                const prior = await commands.findOneBy({ operatorIdentityId: actor.identityId, requestKey: input.requestKey })
                operator = await assertHostingOperator({ manager, actor })
                if (prior) {
                    if (prior.payloadHash !== payloadHash) hostingFail('HOSTING_PARTNER_IDEMPOTENCY_CONFLICT')
                    return { platformId: actor.platformId, userId: operator.id, candidate: await view(manager, actor, identityId), replayed: true }
                }
                const current = await view(manager, actor, identityId)
                if (current.revision !== input.expectedRevision || current.stateHash !== input.expectedState) hostingFail('HOSTING_PARTNER_REVISION_CONFLICT')
                if (current.revision >= 1000) hostingFail('HOSTING_PARTNER_HISTORY_LIMIT')
                const access = createHostedAccess({ dataSource, manager })
                if (assignment) {
                    if (role?.role !== 'partner' || !role.active) hostingFail('HOSTING_PARTNER_REQUIRED')
                    if (input.assigned) await access.assignPartner({ actor, identityId, platformId: input.platformId })
                    else await access.unassignPartner({ actor, identityId, platformId: input.platformId })
                }
                else if (input.active) {
                    // Trusted normal provisioning creates a home for a new verified
                    // account, or preserves an existing independent membership.
                    // This never grants a new trial to an already joined identity.
                    await onboarding.provision({ identityId, name: `${identity.firstName}'s partner workspace`.slice(0, 120), operator: actor, manager })
                    await access.setRole({ actor, identityId, role: 'partner', active: true })
                }
                else await access.setRole({ actor, identityId, role: 'partner', active: false })
                const revision = current.revision + 1
                await commands.insert({ id: apId(), identityId, revision, operatorIdentityId: actor.identityId, requestKey: input.requestKey, payloadHash, action, platformId })
                await manager.getRepository(HostingPartnerAdminBindingEntity).save({ id: identityId, revision })
                await tx.event({ manager, platformId: actor.platformId, event: 'operational.partner.admin.changed', payload: { actorIdentityId: actor.identityId, identityId, action, targetPlatformId: platformId, revision } })
                return { platformId: actor.platformId, userId: operator.id, candidate: await view(manager, actor, identityId), replayed: false }
            } })
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') hostingFail('HOSTING_PARTNER_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    return { lookup, list, mutate }
}

async function view(manager: EntityManager, actor: HostingActor, identityId: string) {
    const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
    const role = await manager.getRepository(HostingAccessRoleEntity).findOneBy({ id: identityId })
    const binding = await manager.getRepository(HostingPartnerAdminBindingEntity).findOneBy({ id: identityId })
    const memberships = await manager.getRepository(HostingAccessMembershipEntity).find({ where: { identityId }, order: { platformId: 'ASC' }, take: 101 })
    if (memberships.length > 100) hostingFail('HOSTING_PARTNER_ASSIGNMENT_LIMIT')
    const owned = await manager.getRepository(HostingAccountEntity).find({ where: { ownerIdentityId: identityId }, order: { id: 'ASC' }, take: 100 })
    const names = new Map<string, string>()
    for (const platformId of new Set([...owned.map(account => account.id), ...memberships.map(membership => membership.platformId)])) {
        const platform = await manager.getRepository(PlatformEntity).findOneBy({ id: platformId })
        if (platform) names.set(platformId, platform.name)
    }
    const users = await manager.getRepository(UserEntity).find({ where: { identityId, status: UserStatus.ACTIVE }, take: 100 })
    return {
        identityId, email: identity.email, firstName: identity.firstName, lastName: identity.lastName, verified: identity.verified,
        ...await identityAdmission(manager, identity),
        role: role?.role ?? null, active: role?.active ?? false, revision: binding?.revision ?? 0,
        stateHash: hash({ verified: identity.verified, role: role?.role ?? null, active: role?.active ?? false, memberships: memberships.map(({ id, platformId, userId, role, active }) => ({ id, platformId, userId, role, active })) }),
        editable: identityId !== actor.identityId && !hostingOperatorIdentityIds().includes(identityId) && role?.role !== 'team',
        signInAvailable: users.some(user => !isOperationalUser(user)),
        workspaces: owned.map(account => ({ platformId: account.id, name: names.get(account.id) ?? 'Workspace' })),
        assignments: memberships.filter(membership => membership.role === 'partner').map(membership => ({ platformId: membership.platformId, name: names.get(membership.platformId) ?? 'Workspace', active: membership.active })),
    }
}
function hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
