import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { cryptoUtils } from '@activepieces/server-utils'
import { hostingCatalog, MAX_FULL_NAME_LENGTH, PasswordType, PlatformRole, UserIdentityProvider } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { DataSource, EntityManager, MoreThan } from 'typeorm'
import { z } from 'zod'
import { passwordHasher } from '../authentication/lib/password-hasher'
import { signupNames } from '../authentication/lib/signup-names'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { hostedCustomerSeatCount, hostedWorkspaceAllowsMembers, isOperationalUser } from './hosting-access-policy'
import { HostingAccountEntity, HostingInvitationEntity } from './hosting-entities'
import { identityAdmission } from './hosting-identity-admission'
import { createHostedOnboarding } from './hosting-onboarding'
import { subscriptionAccountUntil } from './hosting-subscription-policy'
import { HostingTenantMembersBindingEntity, HostingTenantMembersCommandEntity } from './hosting-tenant-members-entities'
import { assertTenantAdministrator, assertTenantMemberTarget } from './hosting-tenant-members-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const id = z.string().length(21)
// A full 100-seat workspace also retains inactive users and operational staff.
// Keep the directory bounded without confusing that bound with paid seats.
const MEMBER_DIRECTORY_LIMIT = 1000
const cas = z.object({ expectedRevision: z.number().int().min(0).max(10000), expectedState: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/) })
export const TenantMemberInviteInput = cas.extend({ email: z.email().max(254).transform(value => value.trim().toLowerCase()), role: z.enum(PlatformRole) }).strict()
export const TenantMemberChangeInput = cas.extend({ userId: id, role: z.enum(PlatformRole).optional(), deactivate: z.literal(true).optional() }).strict().refine(value => value.role !== undefined || value.deactivate === true)
export const TenantMemberRevokeInput = cas.extend({ invitationId: id }).strict()
export const TenantMemberSecret = z.string().regex(/^[a-zA-Z0-9_-]{43}$/)
export const TenantMemberRedeemInput = z.strictObject({ token: TenantMemberSecret, password: PasswordType, fullName: z.string().trim().min(1).max(MAX_FULL_NAME_LENGTH).optional() })
type Onboarding = ReturnType<typeof createHostedOnboarding>
type Input = z.infer<typeof TenantMemberInviteInput> | z.infer<typeof TenantMemberChangeInput> | z.infer<typeof TenantMemberRevokeInput>

export function createHostedTenantMembers({ dataSource, onboarding, log }: { dataSource: DataSource, onboarding: Onboarding, log: FastifyBaseLogger }) {
    async function list({ actor }: { actor: HostingActor }) {
        return tx.run({ dataSource, fn: async manager => {
            await assertTenantAdministrator({ manager, actor })
            return view(manager, actor)
        } })
    }
    async function command({ actor, input, action }: { actor: HostingActor, input: Input, action: 'invite' | 'change' | 'revoke' }) {
        const value = action === 'invite' ? TenantMemberInviteInput.parse(input) : action === 'change' ? TenantMemberChangeInput.parse(input) : TenantMemberRevokeInput.parse(input)
        const requestHash = hash({ action, input: value })
        try {
            return await tx.run({ dataSource, fn: async manager => {
                await assertTenantAdministrator({ manager, actor })
                const workspace = await manager.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })
                if (action === 'invite' && !await hostedWorkspaceAllowsMembers(manager, workspace)) hostingFail('HOSTING_PARTNER_SINGLE_USER')
                // Target identity first, account and platform second, matching normal
                // onboarding and operational membership revocation lock order.
                let identityId: string
                if ('email' in value) {
                    let identity = await manager.getRepository(UserIdentityEntity).findOneBy({ email: value.email })
                    if (!identity) identity = await userIdentityService(log).create({ email: value.email, firstName: signupNames.firstNameFromEmail(value.email), lastName: '', password: await cryptoUtils.generateRandomPassword(), provider: UserIdentityProvider.EMAIL, verified: false, trackEvents: false, newsLetter: false }, manager)
                    identityId = identity.id
                }
                else if ('userId' in value) {
                    const user = await manager.getRepository(UserEntity).findOneBy({ id: value.userId, platformId: actor.platformId })
                    if (!user || isOperationalUser(user)) hostingFail('HOSTING_MEMBER_PROTECTED')
                    identityId = user.identityId
                }
                else {
                    const old = await manager.getRepository(HostingTenantMembersCommandEntity).findOneBy({ platformId: actor.platformId, invitationId: value.invitationId, action: 'invite' })
                    if (!old && !await manager.getRepository(HostingInvitationEntity).existsBy({ id: value.invitationId, platformId: actor.platformId })) hostingFail('HOSTING_MEMBER_INVITATION_UNAVAILABLE')
                    identityId = old?.identityId ?? actor.identityId
                }
                const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: identityId }, lock: { mode: 'pessimistic_write' } })
                if (!identity) hostingFail('HOSTING_MEMBER_UNAVAILABLE')
                const account = await tx.account({ manager, platformId: actor.platformId })
                await manager.getRepository(PlatformEntity).findOneOrFail({ where: { id: account.id }, lock: { mode: 'pessimistic_write' } })
                await assertTenantAdministrator({ manager, actor })
                if (action !== 'revoke') await assertTenantMemberTarget({ manager, identityId, actorIdentityId: actor.identityId })
                if (action !== 'revoke' && account.ownerIdentityId === identityId) hostingFail('HOSTING_MEMBER_PROTECTED')
                const repository = manager.getRepository(HostingTenantMembersCommandEntity)
                const prior = await repository.findOneBy({ platformId: account.id, actorIdentityId: actor.identityId, requestKey: value.requestKey })
                if (prior) {
                    if (prior.requestHash !== requestHash) hostingFail('HOSTING_MEMBERS_IDEMPOTENCY_CONFLICT')
                    return { ...await view(manager, actor), setupUrl: null, replayed: true }
                }
                const current = await view(manager, actor)
                if (current.revision !== value.expectedRevision || current.stateHash !== value.expectedState) hostingFail('HOSTING_MEMBERS_REVISION_CONFLICT')
                if (current.revision >= 10000) hostingFail('HOSTING_MEMBERS_HISTORY_LIMIT')
                const now = await tx.now(manager)
                tx.assertActive({ account, now })
                let invitationId: string | null = null, mode: 'setup' | 'existing' | null = null, setupUrl: string | null = null
                if ('email' in value) {
                    if (identity.email !== value.email) hostingFail('HOSTING_MEMBER_UNAVAILABLE')
                    mode = identity.verified ? 'existing' : 'setup'
                    if (mode === 'setup') await assertUnused(manager, identityId)
                    const invitation = await onboarding.invite({ actor, email: identity.email, role: value.role, manager })
                    invitationId = invitation.id
                    const expiresAt = new Date(Math.min(subscriptionAccountUntil(account).getTime(), now.getTime() + 24 * 60 * 60_000))
                    await manager.getRepository(HostingInvitationEntity).update({ id: invitation.id }, { expiresAt })
                    const url = new URL('/tenant-join', system.getOrThrow(AppSystemProp.FRONTEND_URL)); url.hash = `token=${invitation.token}`; setupUrl = url.href
                }
                else if ('userId' in value) await onboarding.changeMember({ actor, userId: value.userId, role: value.role, deactivate: value.deactivate, manager })
                else await onboarding.revokeInvitation({ actor, invitationId: value.invitationId, manager })
                const revision = current.revision + 1
                await repository.insert({ id: apId(), platformId: account.id, identityId, identityEmail: identity.email, identityTokenVersion: identity.tokenVersion ?? null, actorIdentityId: actor.identityId, actorTokenVersion: actor.tokenVersion ?? null, revision, requestKey: value.requestKey, requestHash, action, invitationId, mode, usedAt: null })
                await manager.getRepository(HostingTenantMembersBindingEntity).save({ id: account.id, revision })
                await tx.event({ manager, platformId: account.id, event: `tenant.member.${action}`, payload: { actorIdentityId: actor.identityId, identityId, revision, invitationId: 'invitationId' in value ? value.invitationId : invitationId, userId: 'userId' in value ? value.userId : null, mode } })
                return { ...await view(manager, actor), setupUrl, replayed: false }
            } })
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') hostingFail('HOSTING_MEMBERS_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    async function inspect(token: string) {
        TenantMemberSecret.parse(token)
        return tx.run({ dataSource, fn: async manager => {
            const { command: link, invitation, platform } = await usable(manager, token)
            return { email: link.identityEmail, workspaceName: platform.name, role: invitation.role, mode: link.mode, expiresAt: invitation.expiresAt.toISOString(), emailOwnershipVerified: false }
        } })
    }
    async function redeem(input: z.infer<typeof TenantMemberRedeemInput>) {
        const value = TenantMemberRedeemInput.parse(input)
        // Peek only to choose a credential primitive. The capability, identity,
        // password/session version, issuer and capacity are rechecked under locks.
        const peek = await dataSource.getRepository(HostingInvitationEntity).findOneBy({ tokenDigest: hash(value.token) })
        const link = peek ? await dataSource.getRepository(HostingTenantMembersCommandEntity).findOneBy({ invitationId: peek.id, action: 'invite' }) : null
        if (!link) hostingFail('HOSTING_MEMBER_LINK_UNAVAILABLE')
        let authenticatedVersion: string | null = null, newPassword: string | null = null
        if (link.mode === 'existing') {
            const authenticated = await userIdentityService(log).verifyIdentityPassword({ email: link.identityEmail, password: value.password })
            if (authenticated.id !== link.identityId) hostingFail('HOSTING_MEMBER_LINK_UNAVAILABLE')
            authenticatedVersion = authenticated.tokenVersion ?? null
        }
        else {
            if (!value.fullName) hostingFail('HOSTING_MEMBER_NAME_REQUIRED')
            newPassword = await passwordHasher.hash(value.password)
        }
        return tx.run({ dataSource, fn: async manager => {
            const usableLink = await usable(manager, value.token)
            const identity = usableLink.identity, current = usableLink.command
            if (current.id !== link.id || current.mode !== link.mode || (current.mode === 'existing' && (identity.tokenVersion ?? null) !== authenticatedVersion)) hostingFail('HOSTING_MEMBER_LINK_UNAVAILABLE')
            if (current.mode === 'setup') {
                const names = signupNames.splitFullName({ fullName: value.fullName!, email: identity.email })
                await manager.getRepository(UserIdentityEntity).update({ id: identity.id }, { ...names, password: newPassword!, verified: true, tokenVersion: apId() })
            }
            const updatedIdentity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: identity.id })
            const tenant = await onboarding.acceptInvitation({ identityId: identity.id, token: value.token, expectedTokenVersion: updatedIdentity.tokenVersion ?? null, manager })
            await manager.getRepository(HostingTenantMembersCommandEntity).update({ id: current.id }, { usedAt: await tx.now(manager) })
            await tx.event({ manager, platformId: tenant.platformId, event: 'tenant.member.joined', payload: { identityId: identity.id, actorIdentityId: current.actorIdentityId, invitationId: current.invitationId, admissionSource: current.mode === 'setup' ? 'tenant_admin' : 'existing_account', emailOwnershipVerified: false } })
            return tenant
        } })
    }
    async function usable(manager: EntityManager, token: string) {
        const peek = await manager.getRepository(HostingInvitationEntity).findOneBy({ tokenDigest: hash(token) })
        const link = peek ? await manager.getRepository(HostingTenantMembersCommandEntity).findOneBy({ invitationId: peek.id, action: 'invite' }) : null
        if (!link || link.usedAt) hostingFail('HOSTING_MEMBER_LINK_UNAVAILABLE')
        const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: link.identityId }, lock: { mode: 'pessimistic_write' } })
        if (!identity || identity.email !== link.identityEmail || (identity.tokenVersion ?? null) !== link.identityTokenVersion) hostingFail('HOSTING_MEMBER_LINK_UNAVAILABLE')
        const account = await tx.account({ manager, platformId: link.platformId })
        const platform = await manager.getRepository(PlatformEntity).findOneByOrFail({ id: account.id })
        const invitation = await manager.getRepository(HostingInvitationEntity).findOneBy({ id: link.invitationId!, platformId: link.platformId, tokenDigest: hash(token), status: 'pending' })
        const now = await tx.now(manager)
        if (!invitation || invitation.expiresAt <= now) hostingFail('HOSTING_MEMBER_LINK_UNAVAILABLE')
        tx.assertActive({ account, now })
        await assertTenantAdministrator({ manager, actor: { identityId: link.actorIdentityId, platformId: link.platformId, tokenVersion: link.actorTokenVersion } })
        await assertTenantMemberTarget({ manager, identityId: identity.id, actorIdentityId: link.actorIdentityId })
        if (link.mode === 'setup') await assertUnused(manager, identity.id)
        else if (!identity.verified) hostingFail('HOSTING_MEMBER_LINK_UNAVAILABLE')
        return { command: link, invitation, identity, platform }
    }
    return { list, command, inspect, redeem }
}

async function assertUnused(manager: EntityManager, identityId: string) {
    const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
    if (identity.verified || identity.provider !== UserIdentityProvider.EMAIL || await manager.getRepository(UserEntity).existsBy({ identityId })) hostingFail('HOSTING_MEMBER_ACCOUNT_REQUIRES_SIGN_IN')
}
async function view(manager: EntityManager, actor: HostingActor) {
    const admin = await assertTenantAdministrator({ manager, actor }), account = await tx.account({ manager, platformId: actor.platformId }), now = await tx.now(manager)
    const users = await manager.getRepository(UserEntity).find({ where: { platformId: account.id }, order: { created: 'ASC' }, take: MEMBER_DIRECTORY_LIMIT + 1 })
    if (users.length > MEMBER_DIRECTORY_LIMIT) hostingFail('HOSTING_MEMBER_LIST_LIMIT')
    const members = []
    for (const user of users) {
        const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: user.identityId })
        let protectedMember = isOperationalUser(user) || identity.id === actor.identityId || identity.id === account.ownerIdentityId
        try {
            await assertTenantMemberTarget({ manager, identityId: identity.id, actorIdentityId: actor.identityId }) 
        }
        catch {
            protectedMember = true 
        }
        members.push({ id: user.id, identityId: identity.id, email: identity.email, firstName: identity.firstName, lastName: identity.lastName, status: user.status, platformRole: user.platformRole, verified: identity.verified, ...await identityAdmission(manager, identity), protected: protectedMember, operational: isOperationalUser(user) })
    }
    const invitations = await manager.getRepository(HostingInvitationEntity).findBy({ platformId: account.id, status: 'pending', expiresAt: MoreThan(now) })
    const pending = []
    for (const invitation of invitations) {
        const command = await manager.getRepository(HostingTenantMembersCommandEntity).findOneBy({ invitationId: invitation.id })
        pending.push({ id: invitation.id, email: command?.identityEmail ?? null, role: invitation.role, expiresAt: invitation.expiresAt.toISOString() })
    }
    const revision = (await manager.getRepository(HostingTenantMembersBindingEntity).findOneBy({ id: account.id }))?.revision ?? 0
    const state = { revision, members: users.map(user => [user.id, user.identityId, user.status, user.platformRole, user.externalId]), pending: invitations.sort((a, b) => a.id.localeCompare(b.id)).map(invite => [invite.id, invite.status, invite.role, invite.expiresAt.toISOString()]), plan: account.planId, validUntil: account.validUntil.toISOString(), hold: account.billingHold, status: account.status }
    return { platformId: account.id, userId: admin.id, revision, stateHash: hash(state), members, invitations: pending, canInvite: await hostedWorkspaceAllowsMembers(manager, account), seats: { used: await hostedCustomerSeatCount(manager, account.id), reserved: invitations.length, limit: hostingCatalog.getPlan({ planId: account.planId }).users } }
}
function hash(value: unknown) {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex') 
}
