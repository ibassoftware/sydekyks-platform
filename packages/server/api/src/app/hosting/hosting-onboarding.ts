import { createHash, createHmac, randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { ColorName, hostingCatalog, PlatformRole, ProjectType, UserStatus } from '@activepieces/shared'
import { DataSource, EntityManager, MoreThan } from 'typeorm'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { defaultTheme } from '../flags/theme'
import { McpOAuthTokenEntity } from '../mcp/oauth/token/mcp-oauth-token.entity'
import { PlatformEntity } from '../platform/platform.entity'
import { ProjectEntity } from '../project/project-entity'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator, hostedCustomerSeatCount, hostingOperatorIdentityIds, isOperationalUser } from './hosting-access-policy'
import { HostingAccount, HostingAccountEntity, HostingEligibilityEntity, HostingGrantEntity, HostingInvitationEntity, HostingLedgerEntity, HostingPolicyEntity } from './hosting-entities'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export function createHostedOnboarding({ dataSource, subjectSecret }: { dataSource: DataSource, subjectSecret: string }) {
    if (subjectSecret.length < 32) hostingFail('HOSTING_SUBJECT_SECRET_REQUIRED')
    const subject = (email: string) => createHmac('sha256', subjectSecret).update(`hosting-subject-v1:${email.trim().toLowerCase()}`).digest('hex')

    async function policy(manager: EntityManager): Promise<void> {
        const fingerprint = digest(subjectSecret)
        await manager.getRepository(HostingPolicyEntity).createQueryBuilder().insert().values({ id: 'v1', subjectKeyFingerprint: fingerprint }).orIgnore().execute()
        const existing = await manager.getRepository(HostingPolicyEntity).findOneByOrFail({ id: 'v1' })
        if (existing.subjectKeyFingerprint !== fingerprint) hostingFail('HOSTING_SUBJECT_KEY_CHANGED')
    }

    async function provision({ identityId, name, expectedTokenVersion, names, operator, requireOwnedHome = false, manager: existingManager }: ProvisionParams): Promise<ProvisionedTenant> {
        assertName(name)
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await policy(manager)
            // Creating a learner-owned home is an explicit operator action. Normal
            // sign-in/partner admission continues to preserve joined memberships.
            if (requireOwnedHome) {
                if (!operator) hostingFail('HOSTING_OPERATOR_PROVISIONING_REQUIRED')
                await assertHostingOperator({ manager, actor: operator! })
            }
            const identity = await lockedIdentity({ manager, identityId })
            if (expectedTokenVersion !== undefined && (identity.tokenVersion ?? null) !== expectedTokenVersion) hostingFail('HOSTING_SESSION_EXPIRED')
            const eligibility = manager.getRepository(HostingEligibilityEntity)
            const prior = await eligibility.findOneBy({ id: subject(identity.email) })
            if (prior) {
                if (prior.identityId !== identityId) hostingFail('HOSTING_TRIAL_ALREADY_USED')
                const account = await manager.getRepository(HostingAccountEntity).findOneBy({ id: prior.platformId })
                if (!account || (requireOwnedHome && account.ownerIdentityId !== identityId)) hostingFail('HOSTING_TRIAL_ALREADY_USED')
                const user = await tx.member({ manager, actor: { identityId, platformId: account.id } })
                return { platformId: account.id, userId: user.id, projectId: account.initialProjectId, created: false, tokenVersion: identity.tokenVersion ?? null }
            }
            const joined = await manager.getRepository(UserEntity).find({ where: { identityId, status: UserStatus.ACTIVE }, order: { created: 'ASC' } })
            for (const user of requireOwnedHome ? [] : joined) {
                if (isOperationalUser(user) || !user.platformId || !await manager.getRepository(HostingAccountEntity).existsBy({ id: user.platformId })) continue
                const project = await manager.getRepository(ProjectEntity).findOneBy({ platformId: user.platformId, ownerId: user.id })
                return { platformId: user.platformId, userId: user.id, projectId: project?.id ?? null, created: false, tokenVersion: identity.tokenVersion ?? null }
            }
            // Only trusted operators may create new pilot tenants. The first
            // allowlisted verified operator can bootstrap their own home.
            if (operator) await assertHostingOperator({ manager, actor: operator })
            else if (!hostingOperatorIdentityIds().includes(identityId) || expectedTokenVersion === undefined) hostingFail('HOSTING_OPERATOR_PROVISIONING_REQUIRED')
            if (await eligibility.existsBy({ identityId })) hostingFail('HOSTING_TRIAL_ALREADY_USED')
            const platformId = apId()
            const claim = await eligibility.createQueryBuilder().insert().values({ id: subject(identity.email), identityId, platformId }).orIgnore().returning('id').execute()
            if (claim.identifiers.length !== 1) hostingFail('HOSTING_TRIAL_ALREADY_USED')
            const userId = apId()
            await manager.getRepository(UserEntity).insert({ id: userId, identityId, platformId: null, platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE })
            await manager.getRepository(PlatformEntity).insert({
                id: platformId, ownerId: userId, name: name.trim(), primaryColor: defaultTheme.colors.primary.default,
                logoIconUrl: defaultTheme.logos.logoIconUrl, fullLogoUrl: defaultTheme.logos.fullLogoUrl, favIconUrl: defaultTheme.logos.favIconUrl,
                emailAuthEnabled: true, autoCreatePersonalProjects: false, enforceAllowedAuthDomains: false,
                allowedAuthDomains: [], allowedEmbedOrigins: [], federatedAuthProviders: { saml: null },
                pinnedPieces: [], pieceSelectorConfig: null, cloudAuthEnabled: true, googleAuthEnabled: true,
            })
            await manager.getRepository(UserEntity).update({ id: userId }, { platformId })
            const projectId = await insertProject({ manager, platformId, userId, name: `${names?.firstName ?? identity.firstName}'s Project`, type: ProjectType.PERSONAL })
            const now = await tx.now(manager)
            const trialEndsAt = new Date(now.getTime() + hostingCatalog.trialDays * 86_400_000)
            await manager.getRepository(HostingAccountEntity).insert({ id: platformId, ownerIdentityId: identityId, initialProjectId: projectId, status: 'trialing', planId: 'trial', catalogVersion: hostingCatalog.version, trialStartedAt: now, trialEndsAt, validUntil: trialEndsAt, activeExecutions: 0 })
            const trial = hostingCatalog.getPlan({ planId: 'trial' })
            for (const [meter, amount] of [['execution', BigInt(trial.executions)], ['managed_ai', BigInt(hostingCatalog.trialOperatorCostLimitMicroUsd)]] as const) {
                const grantId = apId()
                await manager.getRepository(HostingGrantEntity).insert({ id: grantId, platformId, sourceKey: `trial:${subject(identity.email)}`, meter, amount, reserved: 0n, consumed: 0n, validFrom: now, validUntil: trialEndsAt })
                await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId, grantId, reservationId: null, operation: 'grant', key: `grant:${grantId}`, amount })
            }
            const tokenVersion = apId()
            await manager.getRepository(UserIdentityEntity).update({ id: identityId }, { ...names, tokenVersion, lastLoggedInPlatformId: platformId })
            await tx.event({ manager, platformId, event: 'tenant.provisioned', payload: { identityId, userId, projectId } })
            return { platformId, userId, projectId, created: true, tokenVersion }
        } })
    }

    async function invite({ actor, email, role }: { actor: HostingActor, email: string, role: PlatformRole }) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !Object.values(PlatformRole).includes(role)) hostingFail('HOSTING_INVALID_INVITATION')
        return tx.run({ dataSource, fn: async manager => {
            await policy(manager)
            const account = await tx.account({ manager, platformId: actor.platformId })
            await lockPlatform({ manager, platformId: actor.platformId })
            await tx.member({ manager, actor, admin: true })
            const now = await tx.now(manager)
            tx.assertActive({ account, now })
            const existingIdentity = await manager.getRepository(UserIdentityEntity).findOneBy({ email: email.trim().toLowerCase() })
            if (existingIdentity && await manager.getRepository(UserEntity).existsBy({ identityId: existingIdentity.id, platformId: actor.platformId, status: UserStatus.ACTIVE })) hostingFail('HOSTING_MEMBER_ALREADY_EXISTS')
            await manager.getRepository(HostingInvitationEntity).update({ platformId: actor.platformId, subject: subject(email), status: 'pending' }, { status: 'revoked' })
            const previous = existingIdentity ? await manager.getRepository(UserEntity).findOneBy({ identityId: existingIdentity.id, platformId: account.id }) : null
            if (previous && isOperationalUser(previous)) hostingFail('HOSTING_OPERATOR_ASSIGNMENT_REQUIRED')
            const projectUnits = previous && await manager.getRepository(ProjectEntity).existsBy({ platformId: account.id, ownerId: previous.id }) ? 0 : 1
            await capacity({ manager, account, now, addUsers: 1, addProjects: projectUnits })
            const token = randomBytes(32).toString('base64url')
            const id = apId()
            const expiresAt = new Date(Math.min(now.getTime() + 7 * 86_400_000, account.validUntil.getTime()))
            await manager.getRepository(HostingInvitationEntity).insert({ id, platformId: actor.platformId, subject: subject(email), role, projectUnits, tokenDigest: digest(token), status: 'pending', expiresAt, acceptedIdentityId: null })
            await tx.event({ manager, platformId: actor.platformId, event: 'invitation.created', payload: { invitationId: id, actorIdentityId: actor.identityId } })
            return { id, token, expiresAt }
        } })
    }

    async function acceptInvitation({ identityId, token, expectedTokenVersion }: { identityId: string, token: string, expectedTokenVersion?: string | null }): Promise<ProvisionedTenant> {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) hostingFail('HOSTING_INVALID_INVITATION')
        return tx.run({ dataSource, fn: async manager => {
            await policy(manager)
            const identity = await lockedIdentity({ manager, identityId })
            if (expectedTokenVersion !== undefined && (identity.tokenVersion ?? null) !== expectedTokenVersion) hostingFail('HOSTING_SESSION_EXPIRED')
            const peek = await manager.getRepository(HostingInvitationEntity).findOneBy({ tokenDigest: digest(token) })
            if (!peek || peek.subject !== subject(identity.email)) hostingFail('HOSTING_INVALID_INVITATION')
            const account = await tx.account({ manager, platformId: peek.platformId })
            await lockPlatform({ manager, platformId: account.id })
            const invitation = await manager.getRepository(HostingInvitationEntity).findOneByOrFail({ id: peek.id, platformId: account.id, tokenDigest: digest(token) })
            if (invitation.status === 'accepted' && invitation.acceptedIdentityId === identityId) {
                const member = await tx.member({ manager, actor: { identityId, platformId: account.id } })
                const project = await manager.getRepository(ProjectEntity).findOneBy({ platformId: account.id, ownerId: member.id })
                return { platformId: account.id, userId: member.id, projectId: project?.id ?? null, created: false, tokenVersion: identity.tokenVersion ?? null }
            }
            const now = await tx.now(manager)
            if (invitation.status !== 'pending' || invitation.expiresAt <= now) hostingFail('HOSTING_INVALID_INVITATION')
            tx.assertActive({ account, now })
            await manager.getRepository(HostingInvitationEntity).update({ id: invitation.id }, { status: 'accepted', acceptedIdentityId: identityId })
            const previous = await manager.getRepository(UserEntity).findOneBy({ platformId: account.id, identityId })
            if (previous && isOperationalUser(previous)) hostingFail('HOSTING_OPERATOR_ASSIGNMENT_REQUIRED')
            const project = previous ? await manager.getRepository(ProjectEntity).findOneBy({ platformId: account.id, ownerId: previous.id }) : null
            const alreadyActive = previous?.status === UserStatus.ACTIVE
            await capacity({ manager, account, now, addUsers: alreadyActive ? 0 : 1, addProjects: project ? 0 : 1 })
            const userId = previous?.id ?? apId()
            if (!alreadyActive) await manager.getRepository(UserEntity).save({ id: userId, identityId, platformId: account.id, platformRole: invitation.role, status: UserStatus.ACTIVE })
            const projectId = project?.id ?? await insertProject({ manager, platformId: account.id, userId, name: `${identity.firstName}'s Project`, type: ProjectType.PERSONAL })
            const tokenVersion = apId()
            await manager.getRepository(UserIdentityEntity).update({ id: identityId }, { tokenVersion, lastLoggedInPlatformId: account.id })
            await tx.event({ manager, platformId: account.id, event: 'invitation.accepted', payload: { invitationId: invitation.id, identityId, userId } })
            return { platformId: account.id, userId, projectId, created: false, tokenVersion }
        } })
    }

    async function changeMember({ actor, userId, role, deactivate = false }: { actor: HostingActor, userId: string, role?: PlatformRole, deactivate?: boolean }): Promise<void> {
        if (role !== undefined && !Object.values(PlatformRole).includes(role)) hostingFail('HOSTING_INVALID_ROLE')
        await tx.run({ dataSource, fn: async manager => {
            const peek = await manager.getRepository(UserEntity).findOneBy({ id: userId, platformId: actor.platformId })
            if (!peek) hostingFail('HOSTING_ACCESS_DENIED')
            if (isOperationalUser(peek)) hostingFail('HOSTING_OPERATOR_ASSIGNMENT_REQUIRED')
            await lockedIdentity({ manager, identityId: peek.identityId })
            await tx.account({ manager, platformId: actor.platformId })
            const platform = await lockPlatform({ manager, platformId: actor.platformId })
            await tx.member({ manager, actor, admin: true })
            if (platform.ownerId === userId && (deactivate || (role !== undefined && role !== PlatformRole.ADMIN))) hostingFail('HOSTING_OWNER_REQUIRED')
            await manager.getRepository(UserEntity).update({ id: userId, platformId: actor.platformId }, { ...(role !== undefined ? { platformRole: role } : {}), ...(deactivate ? { status: UserStatus.INACTIVE } : {}) })
            await manager.getRepository(UserIdentityEntity).update({ id: peek.identityId }, { tokenVersion: apId() })
            await manager.getRepository(McpOAuthTokenEntity).update({ platformId: actor.platformId, userId }, { revoked: true })
            await tx.event({ manager, platformId: actor.platformId, event: 'membership.changed', payload: { actorIdentityId: actor.identityId, userId, deactivate, role: role ?? null } })
        } })
    }

    async function revokeInvitation({ actor, invitationId }: { actor: HostingActor, invitationId: string }): Promise<void> {
        await tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId: actor.platformId })
            await lockPlatform({ manager, platformId: actor.platformId })
            await tx.member({ manager, actor, admin: true })
            const invitation = await manager.getRepository(HostingInvitationEntity).findOneBy({ id: invitationId, platformId: actor.platformId })
            if (!invitation || invitation.status !== 'pending') hostingFail('HOSTING_INVALID_INVITATION')
            await manager.getRepository(HostingInvitationEntity).update({ id: invitation.id }, { status: 'revoked' })
            await tx.event({ manager, platformId: actor.platformId, event: 'invitation.revoked', payload: { invitationId, actorIdentityId: actor.identityId } })
        } })
    }

    async function selectTenant({ actor }: { actor: HostingActor }): Promise<ProvisionedTenant> {
        return tx.run({ dataSource, fn: async manager => {
            const identity = await lockedIdentity({ manager, identityId: actor.identityId })
            await tx.account({ manager, platformId: actor.platformId })
            const user = await tx.member({ manager, actor })
            const project = await manager.getRepository(ProjectEntity).findOneBy({ platformId: actor.platformId, ownerId: user.id })
            await manager.getRepository(UserIdentityEntity).update({ id: actor.identityId }, { lastLoggedInPlatformId: actor.platformId })
            return { platformId: actor.platformId, userId: user.id, projectId: project?.id ?? null, created: false, tokenVersion: identity.tokenVersion ?? null }
        } })
    }

    return { provision, invite, acceptInvitation, changeMember, revokeInvitation, selectTenant }
}

async function capacity({ manager, account, now, addUsers, addProjects }: { manager: EntityManager, account: HostingAccount, now: Date, addUsers: number, addProjects: number }): Promise<void> {
    const plan = hostingCatalog.getPlan({ planId: account.planId })
    const pending = await manager.getRepository(HostingInvitationEntity).findBy({ platformId: account.id, status: 'pending', expiresAt: MoreThan(now) })
    const users = await hostedCustomerSeatCount(manager, account.id)
    const projects = await manager.getRepository(ProjectEntity).countBy({ platformId: account.id })
    if (users + pending.length + addUsers > plan.users || projects + pending.reduce((sum, invitation) => sum + invitation.projectUnits, 0) + addProjects > plan.projects) hostingFail('HOSTING_RESOURCE_LIMIT')
}

async function lockedIdentity({ manager, identityId }: { manager: EntityManager, identityId: string }) {
    const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: identityId }, lock: { mode: 'pessimistic_write' } })
    if (!identity?.verified) hostingFail('HOSTING_VERIFIED_IDENTITY_REQUIRED')
    return identity
}

async function lockPlatform({ manager, platformId }: { manager: EntityManager, platformId: string }) {
    const value = await manager.getRepository(PlatformEntity).findOne({ where: { id: platformId }, lock: { mode: 'pessimistic_write' } })
    if (!value) hostingFail('HOSTING_ACCOUNT_NOT_FOUND')
    return value
}

async function insertProject({ manager, platformId, userId, name, type }: { manager: EntityManager, platformId: string, userId: string, name: string, type: ProjectType }): Promise<string> {
    const id = apId()
    await manager.getRepository(ProjectEntity).insert({ id, platformId, ownerId: userId, displayName: name.slice(0, 120), type, icon: { color: ColorName.BLUE }, releasesEnabled: false, notifyFlowOwnerOnFailure: false, sensitive: false })
    return id
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}
function assertName(name: string): void {
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 120) hostingFail('HOSTING_INVALID_NAME')
}

type ProvisionParams = { requireOwnedHome?: boolean, operator?: HostingActor, manager?: EntityManager, identityId: string, name: string, expectedTokenVersion?: string | null, names?: { firstName: string, lastName: string } }
export type ProvisionedTenant = { platformId: string, userId: string, projectId: string | null, created: boolean, tokenVersion: string | null }
