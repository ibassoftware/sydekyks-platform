import { apId } from '@activepieces/core-utils'
import { Permission, PlatformRole, PrincipalType, ProjectType, UserStatus } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccountEntity, HostingGrantEntity, HostingInvitationEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { initializeHostedSharedProjects } from '../../src/app/hosting/hosting-shared-project'
import { hostingTransactions } from '../../src/app/hosting/hosting-transactions'
import { ProjectEntity } from '../../src/app/project/project-entity'
import { communityAuthorization } from '../../src/app/sydekyks-community/project-access'
import { sydChatAgentAdministrationSupport } from '../../src/app/syd/copilot/tools/chat-agent-administration'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'
import { pinoLogging } from '../../src/app/helper/logger'
const logger = pinoLogging.initLogger()

let ds: DataSource, original: unknown
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-shared-center-secret-at-least-32-characters' })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id.toLowerCase()}@example.invalid`, password: 'unused', provider: 'EMAIL', verified: true, firstName: 'Test', lastName: 'Member' })
    return ds.getRepository(UserIdentityEntity).findOneByOrFail({ id })
}
beforeAll(async () => { ds = await migratedHostedPGlite(); original = Reflect.get(globalThis, '__AP_DB_CONNECTION__'); Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds) })
afterAll(async () => { Reflect.set(globalThis, '__AP_DB_CONNECTION__', original); if (ds?.isInitialized) await ds.destroy() })
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
})
it('shares the existing center across invitations, replay and account selection without granting account administration', async () => {
    const owner = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), owner.id)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.getRepository(HostingAccountEntity).update({ id: home.platformId }, { planId: 'starter' })
    const invited = await identity(), actor = { identityId: owner.id, platformId: home.platformId, tokenVersion: home.tokenVersion }
    const invitation = await onboarding().invite({ actor, email: invited.email, role: PlatformRole.MEMBER })
    const joined = await onboarding().acceptInvitation({ identityId: invited.id, token: invitation.token })
    expect(joined.projectId).toBe(home.projectId)
    expect((await onboarding().acceptInvitation({ identityId: invited.id, token: invitation.token })).projectId).toBe(home.projectId)
    expect((await onboarding().selectTenant({ actor: { identityId: invited.id, platformId: home.platformId } })).projectId).toBe(home.projectId)
    expect(await ds.getRepository(ProjectEntity).count()).toBe(1)
    const permissions = await communityAuthorization.getUserPermissions({ userId: joined.userId, platformId: home.platformId, projectId: home.projectId!, log: logger })
    expect(permissions.has(Permission.WRITE_FLOW)).toBe(true)
    expect(permissions.has(Permission.WRITE_AGENT)).toBe(true)
    expect((await sydChatAgentAdministrationSupport.resolveReadableProjects({ platformId: home.platformId, userId: joined.userId, log: logger })).map(project => project.id)).toEqual([home.projectId])
    expect(await sydChatAgentAdministrationSupport.resolveShare({ projectId: home.projectId!, visibility: 'RESTRICTED' as never, requested: [joined.userId], stored: [], log: logger })).toEqual([joined.userId])
    for (const permission of [Permission.WRITE_PROJECT, Permission.WRITE_PROJECT_MEMBER, Permission.WRITE_INVITATION]) expect(permissions.has(permission)).toBe(false)
    const user = await ds.getRepository(UserEntity).findOneByOrFail({ id: joined.userId })
    await hostingTransactions.member({ manager: ds.manager, actor: { identityId: invited.id, platformId: home.platformId }, projectId: home.projectId!, write: true })
    const principal = { id: user.id, type: PrincipalType.USER, platform: { id: home.platformId } } as Parameters<typeof communityAuthorization.assertProjectAccess>[0]['principal']
    await communityAuthorization.assertProjectAccess({ principal, projectId: home.projectId!, log: logger })
    await expect(communityAuthorization.assertProjectAccess({ principal, projectId: home.projectId!, permission: Permission.WRITE_PROJECT, log: logger })).rejects.toThrow()
    await ds.getRepository(UserEntity).update({ id: user.id }, { platformRole: PlatformRole.OPERATOR })
    await hostingTransactions.member({ manager: ds.manager, actor: { identityId: invited.id, platformId: home.platformId }, projectId: home.projectId!, write: false })
    await expect(hostingTransactions.member({ manager: ds.manager, actor: { identityId: invited.id, platformId: home.platformId }, projectId: home.projectId!, write: true })).rejects.toThrow('HOSTING_PROJECT_ACCESS_DENIED')
    expect((await communityAuthorization.getUserPermissions({ userId: user.id, projectId: home.projectId!, log: logger })).has(Permission.WRITE_FLOW)).toBe(false)
    await ds.getRepository(UserEntity).update({ id: user.id }, { status: UserStatus.INACTIVE })
    expect((await communityAuthorization.getUserPermissions({ userId: user.id, projectId: home.projectId!, log: logger })).size).toBe(0)
})
it('converts the same personal project id without changing content metadata or grants and is idempotent', async () => {
    const owner = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), owner.id)
    await ds.getRepository(ProjectEntity).update({ id: home.projectId! }, { type: ProjectType.PERSONAL, displayName: 'Existing work' })
    const grants = await ds.getRepository(HostingGrantEntity).find()
    await ds.getRepository(HostingInvitationEntity).insert({ id: apId(), platformId: home.platformId, subject: 'a'.repeat(64), tokenDigest: 'b'.repeat(64), role: PlatformRole.MEMBER, projectUnits: 1, status: 'pending', expiresAt: new Date(Date.now() + 86400000), acceptedIdentityId: null })
    await initializeHostedSharedProjects(ds)
    const invitations = await ds.getRepository(HostingInvitationEntity).find()
    expect(invitations[0].projectUnits).toBe(0)
    await initializeHostedSharedProjects(ds)
    expect(await ds.getRepository(HostingInvitationEntity).find()).toEqual(invitations)
    expect(await ds.getRepository(ProjectEntity).count()).toBe(1)
    expect(await ds.getRepository(ProjectEntity).findOneByOrFail({ id: home.projectId! })).toMatchObject({ type: ProjectType.TEAM, displayName: 'Existing work', ownerId: home.userId })
    expect(await ds.getRepository(HostingGrantEntity).find()).toEqual(grants)
})
it('refuses ambiguous legacy centers atomically without deleting or moving anything', async () => {
    const owner = await identity(), home = await bootstrapHostedOperator(ds, onboarding(), owner.id)
    const project = await ds.getRepository(ProjectEntity).findOneByOrFail({ id: home.projectId! })
    await ds.getRepository(ProjectEntity).save({ ...project, id: apId(), displayName: 'Other work' })
    await ds.getRepository(ProjectEntity).update({ id: project.id }, { type: ProjectType.PERSONAL })
    await expect(initializeHostedSharedProjects(ds)).rejects.toThrow('HOSTING_SHARED_CENTER_CONSOLIDATION_REQUIRED')
    expect(await ds.getRepository(ProjectEntity).count()).toBe(2)
    expect((await ds.getRepository(ProjectEntity).findOneByOrFail({ id: project.id })).type).toBe(ProjectType.PERSONAL)
})
