import { apId } from '@activepieces/core-utils'
import { PlatformRole, UserStatus } from '@activepieces/shared'
import fastify from 'fastify'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { passwordHasher } from '../../src/app/authentication/lib/password-hasher'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { HostingAccountEntity, HostingGrantEntity, HostingInvitationEntity, HostingOutboxEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPartnerAdmin } from '../../src/app/hosting/hosting-partner-admin'
import { createHostedTenantMembers, TenantMemberInviteInput } from '../../src/app/hosting/hosting-tenant-members'
import { HostingTenantMembersCommandEntity } from '../../src/app/hosting/hosting-tenant-members-entities'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { ProjectEntity } from '../../src/app/project/project-entity'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, originalConnection: unknown, admin: HostingActor, operator: HostingActor, passwordHash: string
const app = fastify(), password = 'Synthetic-current-account-password-71!', chosen = 'Synthetic-new-member-password-42!'
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-tenant-members-at-least32characters' })
const service = () => createHostedTenantMembers({ dataSource: ds, onboarding: onboarding(), log: app.log })
async function identity(verified = true) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id.toLowerCase()}@test.invalid`, provider: 'EMAIL', password: passwordHash, verified, firstName: 'Synthetic', lastName: 'Member', tokenVersion: 'initial' })
    return ds.getRepository(UserIdentityEntity).findOneByOrFail({ id })
}
async function invite(email: string, role = PlatformRole.MEMBER, requestKey = apId()) {
    const current = await service().list({ actor: admin })
    const input = { email, role, expectedRevision: current.revision, expectedState: current.stateHash, requestKey }
    const result = await service().command({ actor: admin, input, action: 'invite' })
    if (!result.setupUrl) throw new Error('Missing fixture invitation')
    const token = new URLSearchParams(new URL(result.setupUrl).hash.slice(1)).get('token')!
    return { result, token, input }
}
async function command(action: 'change' | 'revoke', fields: Record<string, unknown>) {
    const current = await service().list({ actor: admin })
    return service().command({ actor: admin, action, input: { ...fields, expectedRevision: current.revision, expectedState: current.stateHash, requestKey: apId() } as never })
}
beforeAll(async () => {
    passwordHash = await passwordHasher.hash(password)
    ds = await migratedHostedPGlite(); originalConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__'); Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
})
afterAll(async () => {
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', originalConnection); if (ds?.isInitialized) await ds.destroy(); await app.close() 
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', ''); vi.stubEnv('AP_FRONTEND_URL', 'https://tenant.test.invalid')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const staff = await identity(), staffHome = await bootstrapHostedOperator(ds, onboarding(), staff.id)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', staff.id); operator = { identityId: staff.id, platformId: staffHome.platformId, tokenVersion: staffHome.tokenVersion }
    const owner = await identity(), home = await onboarding().provision({ identityId: owner.id, name: 'Synthetic client', operator })
    admin = { identityId: owner.id, platformId: home.platformId, tokenVersion: home.tokenVersion }
    // Synthetic service input enables the paid plan solely for seat-cap regressions;
    // billing activation and real people are outside this disposable test.
    await ds.getRepository(HostingAccountEntity).update({ id: home.platformId }, { planId: 'starter' })
})
describe('tenant-scoped member administration', () => {
    it('sets a new password and joins only the invited tenant without another home, grant or Partner role', async () => {
        const target = await identity(false), accounts = await ds.getRepository(HostingAccountEntity).count(), grants = await ds.getRepository(HostingGrantEntity).count()
        const issued = await invite(target.email, PlatformRole.MEMBER)
        expect(new URL(issued.result.setupUrl!).pathname).toBe('/tenant-join')
        expect(issued.result.seats).toMatchObject({ used: 1, reserved: 1, limit: 10 })
        expect(JSON.stringify(issued.result.invitations)).not.toContain('mode')
        expect(await service().inspect(issued.token)).toMatchObject({ mode: 'setup', email: target.email })
        const joined = await service().redeem({ token: issued.token, password: chosen, fullName: 'New Member' })
        expect(joined.platformId).toBe(admin.platformId)
        const updated = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target.id })
        expect(updated.verified).toBe(true); expect(await passwordHasher.compare(chosen, updated.password)).toBe(true); expect(updated.tokenVersion).not.toBe(target.tokenVersion)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(accounts); expect(await ds.getRepository(HostingGrantEntity).count()).toBe(grants)
        expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: target.id })).toBe(0)
        const directory = await createHostedPartnerAdmin({ dataSource: ds, onboarding: onboarding() }).lookup({ actor: operator, email: target.email })
        expect(directory.candidate).toMatchObject({ admissionSource: 'tenant_admin', verificationMethod: 'operator', emailOwnershipVerified: false })
        await expect(service().redeem({ token: issued.token, password: chosen, fullName: 'Replay' })).rejects.toThrow()
    })
    it('authenticates an existing verified account without changing its password or other memberships', async () => {
        const target = await identity(), own = await onboarding().provision({ identityId: target.id, name: 'Other workspace', operator })
        const before = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target.id }), link = await invite(target.email)
        await expect(service().redeem({ token: link.token, password: 'Wrong-password-71!' })).rejects.toThrow()
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target.id })).password).toBe(before.password)
        await service().redeem({ token: link.token, password })
        const after = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target.id })
        expect(after.password).toBe(before.password); expect(after.tokenVersion).not.toBe(before.tokenVersion)
        expect(await ds.getRepository(UserEntity).existsBy({ identityId: target.id, platformId: own.platformId, status: UserStatus.ACTIVE })).toBe(true)
        const row = (await service().list({ actor: admin })).members.find(member => member.identityId === target.id)
        expect(row).toMatchObject({ admissionSource: 'email', emailOwnershipVerified: true })
    })
    it('supports verified accounts with no home using their current password', async () => {
        const target = await identity(), issued = await invite(target.email)
        await service().redeem({ token: issued.token, password })
        expect(await ds.getRepository(UserEntity).countBy({ identityId: target.id })).toBe(1)
        expect(await ds.getRepository(HostingAccountEntity).countBy({ ownerIdentityId: target.id })).toBe(0)
    })
    it('makes ten client seats reachable, bounds pending invitations and keeps Partner training at one seat', async () => {
        const one = await identity(), two = await identity(), three = await identity()
        await onboarding().invite({ actor: admin, email: one.email, role: PlatformRole.MEMBER })
        await invite(two.email)
        for (let i = 0; i < 7; i++) await invite(`pending-${i}@test.invalid`)
        await expect(invite(three.email)).rejects.toThrow('RESOURCE_LIMIT')
        expect((await service().list({ actor: admin })).seats).toEqual({ used: 1, reserved: 9, limit: 10 })
        const other = await identity(), own = await onboarding().provision({ identityId: other.id, name: 'Training client', operator })
        await ds.getRepository(HostingAccountEntity).update({ id: own.platformId }, { planId: 'training' })
        const training = { identityId: other.id, platformId: own.platformId, tokenVersion: own.tokenVersion }
        const current = await service().list({ actor: training })
        expect(current.seats).toEqual({ used: 1, reserved: 0, limit: 1 })
        expect(current.canInvite).toBe(false)
        await expect(service().command({ actor: training, action: 'invite', input: { email: three.email, role: PlatformRole.MEMBER, expectedRevision: current.revision, expectedState: current.stateHash, requestKey: apId() } })).rejects.toThrow('PARTNER_SINGLE_USER')
    })
    it('revokes a legacy pending reservation and safely replays its request', async () => {
        const target = await identity(), legacy = await onboarding().invite({ actor: admin, email: target.email, role: PlatformRole.MEMBER }), current = await service().list({ actor: admin })
        const input = { invitationId: legacy.id, expectedRevision: current.revision, expectedState: current.stateHash, requestKey: 'revoke-legacy' }
        await service().command({ actor: admin, action: 'revoke', input })
        expect((await service().command({ actor: admin, action: 'revoke', input })).replayed).toBe(true)
        expect((await service().list({ actor: admin })).seats.reserved).toBe(0)
    })
    it('manages a full Scale directory with inactive users and operational staff outside the paid seats', async () => {
        await ds.getRepository(HostingAccountEntity).update({ id: admin.platformId }, { planId: 'scale' })
        let memberToDeactivate = ''
        for (let i = 0; i < 101; i++) {
            const person = await identity(), userId = apId()
            if (i === 0) memberToDeactivate = userId
            await ds.getRepository(UserEntity).insert({ id: userId, identityId: person.id, platformId: admin.platformId, platformRole: i === 100 ? PlatformRole.OPERATOR : PlatformRole.MEMBER, status: i === 99 ? UserStatus.INACTIVE : UserStatus.ACTIVE, externalId: i === 100 ? `sydekyks-operational:${person.id}` : null })
        }
        const full = await service().list({ actor: admin })
        expect(full.members).toHaveLength(102)
        expect(full.seats).toEqual({ used: 100, reserved: 0, limit: 100 })
        expect(full.members.find(user => user.operational)?.protected).toBe(true)
        await expect(invite('over-scale-limit@test.invalid')).rejects.toThrow('RESOURCE_LIMIT')
        await command('change', { userId: memberToDeactivate, deactivate: true })
        await invite('replacement-scale-member@test.invalid')
        const replacement = await service().list({ actor: admin })
        expect(replacement.members).toHaveLength(102)
        expect(replacement.seats).toEqual({ used: 99, reserved: 1, limit: 100 })
    })
    it('returns a secret once, revokes replaced links, rejects stale CAS and conflicting idempotency', async () => {
        const target = await identity(false), first = await invite(target.email, PlatformRole.MEMBER, 'once')
        const replay = await service().command({ actor: admin, action: 'invite', input: first.input })
        expect(replay).toMatchObject({ replayed: true, setupUrl: null })
        await expect(service().command({ actor: admin, action: 'invite', input: { ...first.input, role: PlatformRole.ADMIN } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        const stale = TenantMemberInviteInput.parse({ ...first.input, requestKey: 'stale' })
        await expect(service().command({ actor: admin, action: 'invite', input: stale })).rejects.toThrow('REVISION_CONFLICT')
        const replacement = await invite(target.email); await expect(service().inspect(first.token)).rejects.toThrow()
        await command('revoke', { invitationId: replacement.result.invitations[0].id }); await expect(service().inspect(replacement.token)).rejects.toThrow()
    })
    it('fails closed after recipient ownership/version changes, issuer revocation and expiry', async () => {
        const target = await identity(false), issued = await invite(target.email)
        await ds.getRepository(UserIdentityEntity).update({ id: target.id }, { tokenVersion: 'ownership-changed' })
        await expect(service().redeem({ token: issued.token, password: chosen, fullName: 'No takeover' })).rejects.toThrow()
        await ds.getRepository(UserIdentityEntity).update({ id: target.id }, { tokenVersion: target.tokenVersion })
        await ds.getRepository(UserIdentityEntity).update({ id: admin.identityId }, { tokenVersion: 'issuer-revoked' })
        await expect(service().inspect(issued.token)).rejects.toThrow('TENANT_ADMIN_REQUIRED')
        await ds.getRepository(UserIdentityEntity).update({ id: admin.identityId }, { tokenVersion: admin.tokenVersion })
        await ds.getRepository(HostingInvitationEntity).update({ id: issued.result.invitations[0].id }, { expiresAt: new Date(0) })
        await expect(service().inspect(issued.token)).rejects.toThrow('LINK_UNAVAILABLE')
    })
    it('protects owners, team/operators and unverified used accounts against client takeover', async () => {
        const owner = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: admin.identityId, platformId: admin.platformId })
        await expect(command('change', { userId: owner.id, role: PlatformRole.MEMBER })).rejects.toThrow('PROTECTED')
        const staff = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: operator.identityId })
        await expect(invite(staff.email)).rejects.toThrow('PROTECTED')
        const used = await identity(false)
        await ds.getRepository(UserEntity).insert({ id: apId(), identityId: used.id, platformId: admin.platformId, platformRole: PlatformRole.MEMBER, status: UserStatus.INACTIVE })
        await expect(invite(used.email)).rejects.toThrow('REQUIRES_SIGN_IN')
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: used.id })).password).toBe(passwordHash)
    })
    it('role changes and deactivation revoke old sessions while preserving membership/project history', async () => {
        const target = await identity(), issued = await invite(target.email), tenant = await service().redeem({ token: issued.token, password })
        const oldVersion = tenant.tokenVersion
        await command('change', { userId: tenant.userId, role: PlatformRole.ADMIN })
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target.id })).tokenVersion).not.toBe(oldVersion)
        await expect(service().list({ actor: { identityId: target.id, platformId: admin.platformId, tokenVersion: oldVersion } })).rejects.toThrow('TENANT_ADMIN_REQUIRED')
        await command('change', { userId: tenant.userId, deactivate: true })
        expect(await ds.getRepository(UserEntity).findOneBy({ id: tenant.userId })).toMatchObject({ status: UserStatus.INACTIVE })
        expect(await ds.getRepository(ProjectEntity).existsBy({ ownerId: tenant.userId })).toBe(true)
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'membership.changed' })).toBe(2)
    })
    it('denies nonadmins, stale sessions and cross-tenant changes without exposing another directory', async () => {
        const target = await identity(), issued = await invite(target.email), tenant = await service().redeem({ token: issued.token, password })
        await expect(service().list({ actor: { identityId: target.id, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion } })).rejects.toThrow('TENANT_ADMIN_REQUIRED')
        await expect(service().list({ actor: { ...admin, tokenVersion: 'stale' } })).rejects.toThrow('TENANT_ADMIN_REQUIRED')
        const other = await identity(), home = await onboarding().provision({ identityId: other.id, name: 'Unrelated', operator })
        await expect(command('change', { userId: home.userId, role: PlatformRole.MEMBER })).rejects.toThrow('PROTECTED')
        expect((await service().list({ actor: admin })).members.some(member => member.identityId === other.id)).toBe(false)
        expect(await ds.getRepository(HostingTenantMembersCommandEntity).countBy({ action: 'change' })).toBe(0)
    })
})
