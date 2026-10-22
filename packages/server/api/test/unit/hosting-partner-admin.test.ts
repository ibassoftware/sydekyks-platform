import { apId } from '@activepieces/core-utils'
import { PlatformRole, UserStatus } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { createHostedAccess } from '../../src/app/hosting/hosting-access'
import { HostingAccessMembershipEntity, HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { assertHostingOperator, hasOperationalAccess, hostedCustomerSeatCount, hostedWorkspaceAllowsMembers } from '../../src/app/hosting/hosting-access-policy'
import { HostingAccountEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPartnerAdmin, PartnerAssignmentInput, PartnerDecisionInput } from '../../src/app/hosting/hosting-partner-admin'
import { HostingPartnerAdminCommandEntity } from '../../src/app/hosting/hosting-partner-admin-entities'
import { assertTenantAdministrator } from '../../src/app/hosting/hosting-tenant-members-policy'
import { HostingActor, hostingTransactions } from '../../src/app/hosting/hosting-transactions'
import { mcpOAuthRevocationList } from '../../src/app/mcp/oauth/token/mcp-oauth-revocation-list'
import { McpOAuthTokenEntity } from '../../src/app/mcp/oauth/token/mcp-oauth-token.entity'
import { mcpOAuthTokenService } from '../../src/app/mcp/oauth/token/mcp-oauth-token.service'
import { PlatformEntity } from '../../src/app/platform/platform.entity'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

// Persisted synthetic identities are inputs to this service-level regression.
// Normal signup/OTP delivery is covered separately through the disposable HTTP
// acceptance fixture; no test fabricates a verified identity in that journey.
let ds: DataSource, operator: HostingActor, target: string
let onboarding: ReturnType<typeof createHostedOnboarding>
const admin = () => createHostedPartnerAdmin({ dataSource: ds, onboarding })
const access = () => createHostedAccess({ dataSource: ds })
async function identity(verified = true) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', password: 'unused-service-fixture', verified, firstName: 'Partner', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
async function candidate(identityId = target) {
    const identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
    const result = (await admin().lookup({ actor: operator, email: identity.email })).candidate
    if (!result) throw new Error('Fixture lookup missing')
    return result
}
async function decision(active: boolean, key = apId(), identityId = target) {
    const current = await candidate(identityId)
    return admin().mutate({ actor: operator, identityId, input: { active, requestKey: key, expectedRevision: current.revision, expectedState: current.stateHash } })
}
async function assignment(platformId: string, assigned: boolean, key = apId()) {
    const current = await candidate()
    return admin().mutate({ actor: operator, identityId: target, input: { platformId, assigned, requestKey: key, expectedRevision: current.revision, expectedState: current.stateHash } })
}
async function client() {
    const identityId = await identity(), home = await onboarding.provision({ identityId, name: 'Client fixture', operator })
    return { identityId, ...home, actor: { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion } }
}
beforeAll(async () => {
    ds = await migratedHostedPGlite()
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => {
    vi.unstubAllEnvs(); vi.restoreAllMocks()
})
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-partner-service-fixture-at-least32' })
    const operatorId = await identity(), home = await bootstrapHostedOperator(ds, onboarding, operatorId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', operatorId)
    operator = { identityId: operatorId, platformId: home.platformId, tokenVersion: home.tokenVersion }
    target = await identity()
})

describe('operator partner administration', () => {
    it('pages 105 Partners without duplicates, reports the filtered total and searches company/name/email before pagination', async () => {
        const rows = Array.from({ length: 105 }, (_, index) => ({ id: apId(), email: `directory-${String(index).padStart(3, '0')}@test.invalid`, provider: 'EMAIL', password: 'unused-service-fixture', verified: true, firstName: 'Directory', lastName: `Person ${index}`, tokenVersion: 'initial' }))
        await ds.getRepository(UserIdentityEntity).insert(rows)
        await ds.getRepository(HostingAccessRoleEntity).insert(rows.map((row, index) => ({ id: row.id, role: 'partner' as const, active: index % 2 === 0 })))
        const seen: string[] = []
        let after: string | undefined
        do {
            const page = await admin().list({ actor: operator, after })
            expect(page.total).toBe(105)
            expect(page.partners.length).toBeLessThanOrEqual(25)
            seen.push(...page.partners.map(value => value.identityId))
            after = page.next ?? undefined
        } while (after)
        expect(new Set(seen).size).toBe(105)
        expect(seen).toHaveLength(105)
        const exact = await admin().list({ actor: operator, search: 'DIRECTORY-104@TEST.INVALID' })
        expect(exact.total).toBe(1)
        expect(exact.partners[0].identityId).toBe(rows[104].id)
        expect((await admin().list({ actor: operator, search: 'Person 104', status: 'active' })).total).toBe(1)
        expect((await admin().list({ actor: operator, status: 'active' })).total).toBe(53)
        expect((await admin().list({ actor: operator, status: 'inactive' })).total).toBe(52)
        expect((await admin().list({ actor: operator, search: '%' })).total).toBe(0)
        await decision(true)
        const account = await ds.getRepository(HostingAccountEntity).findOneByOrFail({ ownerIdentityId: target })
        await ds.getRepository(PlatformEntity).update({ id: account.id }, { name: 'Literal % _ Company' })
        expect((await admin().list({ actor: operator, search: 'literal % _' })).partners.map(value => value.identityId)).toEqual([target])
    })
    it('looks up exact normalized email without approving unverified, operator or team identities', async () => {
        const account = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
        expect((await admin().lookup({ actor: operator, email: ` ${account.email.toUpperCase()} ` })).candidate?.identityId).toBe(target)
        expect((await admin().lookup({ actor: operator, email: 'missing@test.invalid' })).candidate).toBeNull()
        const unverified = await identity(false)
        await expect(decision(true, apId(), unverified)).rejects.toThrow('VERIFIED_IDENTITY_REQUIRED')
        await expect(decision(true, apId(), operator.identityId)).rejects.toThrow('IDENTITY_PROTECTED')
        await access().setRole({ actor: operator, identityId: target, role: 'team', active: false })
        await expect(decision(true)).rejects.toThrow('IDENTITY_PROTECTED')
        expect(await ds.getRepository(HostingPartnerAdminCommandEntity).count()).toBe(0)
    })
    it('provisions a verified new account home and approves only Partner, without client assignments', async () => {
        const approved = await decision(true)
        expect(approved.candidate).toMatchObject({ role: 'partner', active: true, revision: 1, signInAvailable: true, assignments: [] })
        expect(approved.candidate.workspaces).toHaveLength(1)
        const account = await ds.getRepository(HostingAccountEntity).findOneByOrFail({ ownerIdentityId: target })
        const user = await ds.getRepository(UserEntity).findOneByOrFail({ platformId: account.id, identityId: target })
        expect(user).toMatchObject({ platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE, externalId: null })
        expect(await ds.getRepository(HostingAccessMembershipEntity).countBy({ identityId: target })).toBe(0)
    })
    it('rejects client administrators and stale operators without exposing the directory or mutating access', async () => {
        const ordinary = await client(), current = await candidate()
        for (const actor of [ordinary.actor, { ...operator, tokenVersion: 'stale' }]) {
            await expect(admin().lookup({ actor, email: `${target}@test.invalid` })).rejects.toThrow('OPERATOR_REQUIRED')
            await expect(admin().list({ actor })).rejects.toThrow('OPERATOR_REQUIRED')
            await expect(admin().mutate({ actor, identityId: target, input: { active: true, requestKey: apId(), expectedRevision: current.revision, expectedState: current.stateHash } })).rejects.toThrow('OPERATOR_REQUIRED')
        }
        expect(await ds.getRepository(HostingAccessRoleEntity).existsBy({ id: target })).toBe(false)
    })
    it('uses revision and role/membership state CAS, idempotency and immutable command history', async () => {
        const current = await candidate(), input = { active: true, requestKey: 'approve-once', expectedRevision: current.revision, expectedState: current.stateHash }
        await admin().mutate({ actor: operator, identityId: target, input })
        expect((await admin().mutate({ actor: operator, identityId: target, input })).replayed).toBe(true)
        expect(await ds.getRepository(HostingPartnerAdminCommandEntity).count()).toBe(1)
        await expect(admin().mutate({ actor: operator, identityId: target, input: { ...input, active: false } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        await expect(admin().mutate({ actor: operator, identityId: target, input: { ...input, requestKey: 'stale-revision' } })).rejects.toThrow('REVISION_CONFLICT')
        const beforeLegacy = await candidate()
        await access().setRole({ actor: operator, identityId: target, role: 'partner', active: false })
        await expect(admin().mutate({ actor: operator, identityId: target, input: { active: true, requestKey: 'stale-state', expectedRevision: beforeLegacy.revision, expectedState: beforeLegacy.stateHash } })).rejects.toThrow('REVISION_CONFLICT')
        const command = await ds.getRepository(HostingPartnerAdminCommandEntity).findOneByOrFail({ identityId: target })
        await expect(ds.getRepository(HostingPartnerAdminCommandEntity).update({ id: command.id }, { action: 'deactivate' })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it('assigns without client invitation and revokes operational tokens while preserving independent home access', async () => {
        await decision(true)
        const home = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: target, platformRole: PlatformRole.ADMIN }), customer = await client()
        await assignment(customer.platformId, true)
        let identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
        const partnerActor = { identityId: target, platformId: home.platformId!, tokenVersion: identity.tokenVersion ?? null }
        const entry = await access().enter({ actor: partnerActor, platformId: customer.platformId })
        const user = await ds.getRepository(UserEntity).findOneByOrFail({ id: entry.userId })
        expect(user.platformRole).toBe(PlatformRole.ADMIN)
        expect(await hasOperationalAccess({ manager: ds.manager, user })).toBe(true)
        await expect(access().enter({ actor: customer.actor, platformId: home.platformId! })).rejects.toThrow('OPERATIONAL_ACCESS_DENIED')
        await assignment(customer.platformId, false)
        await expect(hostingTransactions.run({ dataSource: ds, fn: manager => hostingTransactions.member({ manager, actor: { ...partnerActor, platformId: customer.platformId }, projectId: customer.projectId!, write: true }) })).rejects.toThrow('ACCESS_DENIED')
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ id: user.id })).toMatchObject({ status: UserStatus.INACTIVE })
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ id: home.id })).toEqual(home)
        await assignment(customer.platformId, true)
        identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
        const tokenBefore = identity.tokenVersion
        await decision(false)
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })).tokenVersion).not.toBe(tokenBefore)
        expect(await ds.getRepository(HostingAccessMembershipEntity).countBy({ identityId: target, active: true })).toBe(0)
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ id: home.id })).toEqual(home)
    })
    it('preserves an independent joined membership without inventing ownership or another trial', async () => {
        const customer = await client(), userId = apId(), count = await ds.getRepository(HostingAccountEntity).count()
        await ds.getRepository(UserEntity).insert({ id: userId, identityId: target, platformId: customer.platformId, platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE })
        const before = await ds.getRepository(UserEntity).findOneByOrFail({ id: userId })
        const result = await decision(true)
        expect(result.candidate).toMatchObject({ active: true, signInAvailable: true, workspaces: [], assignments: [] })
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ id: userId })).toEqual(before)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(count)
        const current = await candidate()
        await expect(admin().mutate({ actor: operator, identityId: target, input: { platformId: customer.platformId, assigned: true, requestKey: 'independent-guard', expectedRevision: current.revision, expectedState: current.stateHash } })).rejects.toThrow('EXISTING_CLIENT_MEMBERSHIP')
        expect(await ds.getRepository(HostingPartnerAdminCommandEntity).count()).toBe(1)
    })
    it('gives assigned Partners tenant administration without seats, billing-operator authority or cross-client access', async () => {
        await decision(true)
        const home = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: target, platformRole: PlatformRole.ADMIN })
        const customer = await client(), other = await client()
        const seats = await hostedCustomerSeatCount(ds.manager, customer.platformId)
        await assignment(customer.platformId, true)
        const identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
        const actor = { identityId: target, platformId: home.platformId!, tokenVersion: identity.tokenVersion ?? null }
        const entered = await access().enter({ actor, platformId: customer.platformId })
        const clientActor = { ...actor, platformId: customer.platformId }
        expect((await assertTenantAdministrator({ manager: ds.manager, actor: clientActor })).id).toBe(entered.userId)
        await expect(assertHostingOperator({ manager: ds.manager, actor: clientActor })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(assertTenantAdministrator({ manager: ds.manager, actor: { ...actor, platformId: other.platformId } })).rejects.toThrow('TENANT_ADMIN_REQUIRED')
        expect(await hostedCustomerSeatCount(ds.manager, customer.platformId)).toBe(seats)
        expect(await hostedWorkspaceAllowsMembers(ds.manager, await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: home.platformId! }))).toBe(false)
        expect(await hostedWorkspaceAllowsMembers(ds.manager, await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: customer.platformId }))).toBe(true)
        const listed = await access().list({ actor: clientActor })
        expect(listed.operational).toBe(true)
        expect(listed.workspaces).toEqual(expect.arrayContaining([expect.objectContaining({ platformId: home.platformId, home: true }), expect.objectContaining({ platformId: customer.platformId, home: false })]))
        const returned = await access().enter({ actor: clientActor, platformId: home.platformId! })
        expect(returned.userId).toBe(home.id)
        await ds.getRepository(UserEntity).update({ id: entered.userId }, { platformRole: PlatformRole.OPERATOR })
        await access().enter({ actor: clientActor, platformId: customer.platformId })
        expect((await ds.getRepository(UserEntity).findOneByOrFail({ id: entered.userId })).platformRole).toBe(PlatformRole.ADMIN)
        await assignment(customer.platformId, false)
        await expect(assertTenantAdministrator({ manager: ds.manager, actor: clientActor })).rejects.toThrow('TENANT_ADMIN_REQUIRED')
    })
    it('keeps the independent Partner home visible when the assigned-client directory reaches its bound', async () => {
        await decision(true)
        const home = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: target, platformRole: PlatformRole.ADMIN })
        const template = await client()
        const platform = await ds.getRepository(PlatformEntity).createQueryBuilder('platform').addSelect('platform.federatedAuthProviders').where('platform.id = :id', { id: template.platformId }).getOneOrFail()
        const account = await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: template.platformId })
        const entries = Array.from({ length: 100 }, () => ({ platformId: apId(), userId: apId(), ownerId: apId() }))
        // Persist synthetic directory fixtures in one batch; this test never
        // provisions runtime grants or impersonates paid billing admission.
        await ds.getRepository(UserEntity).insert(entries.map(entry => ({ id: entry.ownerId, identityId: template.identityId, platformId: null, platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE })))
        await ds.getRepository(PlatformEntity).insert(entries.map(entry => ({ ...platform, id: entry.platformId, ownerId: entry.ownerId, name: 'Assigned client fixture' })))
        await ds.getRepository(HostingAccountEntity).insert(entries.map(entry => ({ ...account, id: entry.platformId })))
        await ds.getRepository(UserEntity).insert(entries.map(entry => ({ id: entry.userId, identityId: target, platformId: entry.platformId, platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE, externalId: `sydekyks-operational:${target}` })))
        await ds.getRepository(HostingAccessMembershipEntity).insert(entries.map(entry => ({ id: apId(), platformId: entry.platformId, userId: entry.userId, identityId: target, role: 'partner' as const, active: true })))
        const identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
        const list = await access().list({ actor: { identityId: target, platformId: home.platformId!, tokenVersion: identity.tokenVersion ?? null } })
        expect(list.workspaces).toHaveLength(100)
        expect(list.workspaces[0]).toMatchObject({ platformId: home.platformId, home: true })
    })
    it('checks assigned-client MCP context on every authentication and revokes the client grant without changing home access', async () => {
        const previous = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
        Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
        try {
            await decision(true)
            const customer = await client(), other = await client()
            await assignment(customer.platformId, true)
            const user = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: target, platformId: customer.platformId })
            const grantId = apId(), payload = { sub: user.id, platformId: customer.platformId, projectId: customer.projectId!, clientId: 'synthetic-client', grantId, clientKey: 'unknown' as const, scopes: [], type: 'mcp_oauth' as const, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 }
            await ds.getRepository(McpOAuthTokenEntity).insert({ id: grantId, refreshToken: 'synthetic-never-issued-refresh', userId: user.id, platformId: customer.platformId, projectId: customer.projectId!, clientId: payload.clientId, clientKey: payload.clientKey, scopes: [], expiresAt: new Date(Date.now() + 60000).toISOString(), revoked: false, lastUsedAt: null })
            const verified = vi.spyOn(mcpOAuthTokenService, 'verifyAccessToken').mockResolvedValue(payload)
            vi.spyOn(mcpOAuthRevocationList, 'isRevoked').mockResolvedValue(false)
            const log = { debug: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger
            expect((await mcpOAuthTokenService.authenticate({ token: 'synthetic', log })).status).toBe('ok')
            verified.mockResolvedValue({ ...payload, projectId: other.projectId! })
            expect((await mcpOAuthTokenService.authenticate({ token: 'synthetic', log })).status).toBe('invalid')
            verified.mockResolvedValue(payload)
            await assignment(customer.platformId, false)
            expect((await mcpOAuthTokenService.authenticate({ token: 'synthetic', log })).status).toBe('invalid')
            expect((await ds.getRepository(McpOAuthTokenEntity).findOneByOrFail({ id: grantId })).revoked).toBe(true)
        }
        finally {
            Reflect.set(globalThis, '__AP_DB_CONNECTION__', previous)
        }
    })
    it('bounds mutation inputs and does not accept browser-supplied roles or identities', () => {
        const base = { expectedRevision: 0, expectedState: 'a'.repeat(64), requestKey: 'bounded', active: true }
        expect(PartnerDecisionInput.safeParse({ ...base, role: 'team' }).success).toBe(false)
        expect(PartnerDecisionInput.safeParse({ ...base, expectedRevision: -1 }).success).toBe(false)
        expect(PartnerAssignmentInput.safeParse({ ...base, platformId: apId(), assigned: true }).success).toBe(false)
    })
})
