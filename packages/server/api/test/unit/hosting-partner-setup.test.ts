import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { PlatformRole, PrincipalType, UserStatus } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessTokenManager } from '../../src/app/authentication/lib/access-token-manager'
import { passwordHasher } from '../../src/app/authentication/lib/password-hasher'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { authenticationMiddleware } from '../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { errorHandler } from '../../src/app/helper/error-handler'
import { createHostedAccess } from '../../src/app/hosting/hosting-access'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { HostingAccountEntity, HostingGrantEntity, HostingOutboxEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { createHostedPartnerSetup } from '../../src/app/hosting/hosting-partner-setup'
import { hostingPartnerSetupController, hostingPartnerSetupPublicController } from '../../src/app/hosting/hosting-partner-setup-controller'
import { HostingPartnerSetupBindingEntity, HostingPartnerSetupTokenEntity } from '../../src/app/hosting/hosting-partner-setup-entities'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const chosenPassword = 'Synthetic-setup-password-71!', previousPassword = 'Synthetic-previous-password-42!'
const operatorUrl = '/api/v1/hosting/operator/partner-setup', publicUrl = '/api/v1/hosting/partner-setup'
let ds: DataSource, app: FastifyInstance, previousConnection: unknown, operator: HostingActor, operatorUserId: string, target: string, oldHash: string
const service = () => createHostedPartnerSetup({ dataSource: ds, log: app.log })
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-partner-setup-subject-at-least32characters' })
async function identity(verified = false) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', password: oldHash, verified, firstName: 'Before', lastName: 'Setup', tokenVersion: 'initial' })
    return id
}
const readTarget = () => ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
async function issue(expectedRevision = 0, requestKey = apId(), identityId = target) {
    const recipient = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
    const result = await service().command({ actor: operator, action: 'issue', input: { email: recipient.email, expectedRevision, requestKey } })
    if (!result.setupUrl) throw new Error('Fixture expected a newly issued link')
    const token = new URLSearchParams(new URL(result.setupUrl).hash.slice(1)).get('token')
    if (!token) throw new Error('Fixture link missing fragment token')
    return { ...result, token }
}
async function headers(actor = operator, userId = operatorUserId) {
    const token = await accessTokenManager(app.log).generateToken({ id: userId, platform: { id: actor.platformId }, type: PrincipalType.USER, tokenVersion: actor.tokenVersion })
    return { authorization: `Bearer ${token}` }
}
const redeem = (token: string) => service().redeem({ token, password: chosenPassword, fullName: 'New Partner Name' })
async function noAdmission() {
    expect(await ds.getRepository(UserEntity).countBy({ identityId: target })).toBe(0)
    expect(await ds.getRepository(HostingAccountEntity).countBy({ ownerIdentityId: target })).toBe(0)
    expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: target })).toBe(0)
}
beforeAll(async () => {
    oldHash = await passwordHasher.hash(previousPassword)
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    app = fastify()
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); app.setErrorHandler(errorHandler)
    app.addHook('preHandler', authenticationMiddleware); app.addHook('preHandler', authorizationMiddleware)
    await app.register(hostingPartnerSetupController, { prefix: operatorUrl })
    await app.register(hostingPartnerSetupPublicController, { prefix: publicUrl }); await app.ready()
})
afterAll(async () => {
    if (app) await app.close()
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    vi.stubEnv('AP_FRONTEND_URL', 'https://sydekyks.test.invalid'); vi.stubEnv('AP_API_RATE_LIMIT_AUTHN_ENABLED', 'true')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const operatorId = await identity(true), home = await bootstrapHostedOperator(ds, onboarding(), operatorId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', operatorId)
    operator = { identityId: operatorId, platformId: home.platformId, tokenVersion: home.tokenVersion }; operatorUserId = home.userId
    target = await identity()
})

describe('one-use operator partner setup', () => {
    it('stores only a digest, expires after one DB day, and returns the secret only on initial issue', async () => {
        const before = await tx.run({ dataSource: ds, fn: tx.now }), grantCount = await ds.getRepository(HostingGrantEntity).count()
        const link = await issue(0, 'issue-once'), after = await tx.run({ dataSource: ds, fn: tx.now })
        const row = await ds.getRepository(HostingPartnerSetupTokenEntity).findOneByOrFail({ identityId: target })
        expect(row.tokenDigest).toBe(createHash('sha256').update(link.token).digest('hex'))
        expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 86400000)
        expect(row.expiresAt.getTime()).toBeLessThanOrEqual(after.getTime() + 86400000)
        expect(row).toMatchObject({ revision: 1, action: 'issue', usedAt: null, revokedAt: null, method: 'operator', emailOwnershipVerified: false })
        expect(JSON.stringify(row)).not.toContain(link.token)
        const url = new URL(link.setupUrl!)
        expect(url.origin).toBe('https://sydekyks.test.invalid'); expect(url.pathname).toBe('/partner-setup'); expect(url.search).toBe('')
        const status = await service().status({ actor: operator, email: (await readTarget()).email })
        expect(status).toMatchObject({ identityId: target, revision: 1, pending: true }); expect(JSON.stringify(status)).not.toContain(link.token)
        const replay = await service().command({ actor: operator, action: 'issue', input: { email: (await readTarget()).email, expectedRevision: 0, requestKey: 'issue-once' } })
        expect(replay).toMatchObject({ replayed: true, setupUrl: null, revision: 1 })
        expect(await ds.getRepository(HostingPartnerSetupTokenEntity).count()).toBe(1)
        expect(await ds.getRepository(HostingGrantEntity).count()).toBe(grantCount)
        await noAdmission()
    })
    it('sets the chosen password through the real hasher, rotates the old session, and requires separate partner approval', async () => {
        const before = await readTarget(), link = await issue(), grants = await ds.getRepository(HostingGrantEntity).find()
        expect(await service().inspect(link.token)).toEqual({ email: before.email, expiresAt: link.expiresAt, method: 'operator', emailOwnershipVerified: false })
        expect(await redeem(link.token)).toEqual({ completed: true, email: before.email, method: 'operator', emailOwnershipVerified: false, status: 'awaiting_partner_approval' })
        const after = await readTarget()
        expect(after).toMatchObject({ verified: true, firstName: 'New', lastName: 'Partner Name' })
        expect(after.password).not.toBe(chosenPassword); expect(after.password).not.toBe(before.password)
        expect(await passwordHasher.compare(chosenPassword, after.password)).toBe(true)
        expect(await passwordHasher.compare(previousPassword, after.password)).toBe(false)
        expect(after.tokenVersion).not.toBe(before.tokenVersion)
        expect((await ds.getRepository(HostingPartnerSetupTokenEntity).findOneByOrFail({ identityId: target })).usedAt).toBeInstanceOf(Date)
        expect((await ds.getRepository(HostingOutboxEntity).findOneByOrFail({ event: 'operational.partner.setup.completed' })).payload).toMatchObject({ identityId: target, method: 'operator', emailOwnershipVerified: false })
        await expect(redeem(link.token)).rejects.toThrow('LINK_UNAVAILABLE')
        await expect(service().inspect(link.token)).rejects.toThrow('LINK_UNAVAILABLE')
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'operational.partner.setup.completed' })).toBe(1)
        expect(await ds.getRepository(HostingGrantEntity).find()).toEqual(grants)
        await noAdmission()
    })
    it('reissues and revokes with revision CAS, invalidates copied old links, and keeps immutable issuance history', async () => {
        const first = await issue(0, 'first'), email = (await readTarget()).email
        await expect(service().command({ actor: operator, action: 'issue', input: { email, expectedRevision: 0, requestKey: 'stale' } })).rejects.toThrow('REVISION_CONFLICT')
        await expect(service().command({ actor: operator, action: 'revoke', input: { email, expectedRevision: 0, requestKey: 'first' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        const second = await issue(1, 'second')
        expect(second.token).not.toBe(first.token)
        await expect(service().inspect(first.token)).rejects.toThrow('LINK_UNAVAILABLE')
        expect(await service().inspect(second.token)).toMatchObject({ method: 'operator' })
        const revoked = await service().command({ actor: operator, action: 'revoke', input: { email, expectedRevision: 2, requestKey: 'revoke' } })
        expect(revoked).toMatchObject({ revision: 3, pending: false, setupUrl: null })
        await expect(redeem(second.token)).rejects.toThrow('LINK_UNAVAILABLE')
        const original = await ds.getRepository(HostingPartnerSetupTokenEntity).findOneByOrFail({ identityId: target, revision: 1 })
        expect(original.revokedAt).toBeInstanceOf(Date)
        await expect(ds.getRepository(HostingPartnerSetupTokenEntity).update({ id: original.id }, { identityEmail: 'rewritten@test.invalid' })).rejects.toThrow('HISTORY_IMMUTABLE')
        expect((await readTarget()).verified).toBe(false)
    })
    it('commits only one completion when copied links are redeemed concurrently', async () => {
        const link = await issue(), outcomes = await Promise.allSettled([redeem(link.token), redeem(link.token)])
        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
        expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'operational.partner.setup.completed' })).toBe(1)
        expect(await passwordHasher.compare(chosenPassword, (await readTarget()).password)).toBe(true)
        await noAdmission()
    })
    it.each(['issuer-token', 'issuer-allowlist', 'issuer-membership', 'target-token', 'target-email', 'binding-revision'] as const)('fences an already copied link after%s changes', async change => {
        const link = await issue()
        if (change === 'issuer-token') await ds.getRepository(UserIdentityEntity).update({ id: operator.identityId }, { tokenVersion: 'rotated' })
        if (change === 'issuer-allowlist') vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
        if (change === 'issuer-membership') await ds.getRepository(UserEntity).update({ id: operatorUserId }, { status: UserStatus.INACTIVE })
        if (change === 'target-token') await ds.getRepository(UserIdentityEntity).update({ id: target }, { tokenVersion: 'rotated' })
        if (change === 'target-email') await ds.getRepository(UserIdentityEntity).update({ id: target }, { email: 'changed@test.invalid' })
        if (change === 'binding-revision') await ds.getRepository(HostingPartnerSetupBindingEntity).update({ id: target }, { revision: 2 })
        const before = await readTarget()
        await expect(service().inspect(link.token)).rejects.toThrow()
        await expect(redeem(link.token)).rejects.toThrow()
        expect(await readTarget()).toEqual(before)
        expect(await ds.getRepository(HostingOutboxEntity).countBy({ event: 'operational.partner.setup.completed' })).toBe(0)
    })
    it.each(['verified', 'self', 'operator', 'team', 'inactive-member'] as const)('protects%s identities from setup or password replacement', async protectedType => {
        if (protectedType === 'verified') await ds.getRepository(UserIdentityEntity).update({ id: target }, { verified: true })
        if (protectedType === 'self') target = operator.identityId
        if (protectedType === 'operator') vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', `${operator.identityId},${target}`)
        if (protectedType === 'team') await createHostedAccess({ dataSource: ds }).setRole({ actor: operator, identityId: target, role: 'team', active: false })
        if (protectedType === 'inactive-member') await ds.getRepository(UserEntity).insert({ id: apId(), identityId: target, platformId: operator.platformId, platformRole: PlatformRole.MEMBER, status: UserStatus.INACTIVE })
        const before = await readTarget()
        await expect(issue()).rejects.toThrow('ACCOUNT_UNAVAILABLE')
        expect(await readTarget()).toEqual(before)
        expect(await ds.getRepository(HostingPartnerSetupTokenEntity).count()).toBe(0)
    })
    it('uses DB expiry even when the application clock is behind', async () => {
        await issue()
        const issued = await ds.getRepository(HostingPartnerSetupTokenEntity).findOneByOrFail({ identityId: target }), token = 'E'.repeat(43)
        // Seed an independently expired historical fixture; immutable production
        // issuance rows and their server-assigned TTL are never rewritten.
        await ds.getRepository(HostingPartnerSetupTokenEntity).insert({ ...issued, id: apId(), revision: 2, requestKey: 'expired-fixture', tokenDigest: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(0) })
        await ds.getRepository(HostingPartnerSetupBindingEntity).update({ id: target }, { revision: 2 })
        vi.spyOn(Date, 'now').mockReturnValue(0)
        try {
            await expect(service().inspect(token)).rejects.toThrow('LINK_UNAVAILABLE'); await expect(redeem(token)).rejects.toThrow('LINK_UNAVAILABLE')
        }
        finally {
            vi.restoreAllMocks()
        }
        expect((await readTarget()).verified).toBe(false)
    })
})

describe('partner setup HTTP security and disclosure', () => {
    it('creates an unverified identity for a new email without granting a workspace, partner role or password chosen by the operator', async () => {
        const email = `new-${apId()}@test.invalid`, auth = await headers()
        const missing = await app.inject({ url: `${operatorUrl}?email=${encodeURIComponent(email)}`, headers: auth })
        expect(missing.statusCode, missing.body).toBe(200)
        expect(missing.json()).toMatchObject({ identityId: null, revision: 0, pending: false })
        const issued = await app.inject({ method: 'POST', url: `${operatorUrl}/issue`, headers: auth, payload: { email, expectedRevision: 0, requestKey: 'new-email' } })
        expect(issued.statusCode, issued.body).toBe(200)
        const created = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ email })
        target = created.id
        expect(created.verified).toBe(false)
        expect(created.password).toMatch(/^\$2/)
        expect(await passwordHasher.compare(chosenPassword, created.password)).toBe(false)
        await noAdmission()
    })
    it('authorizes issue/status with real signed operator sessions and hides the copied link from status', async () => {
        const email = (await readTarget()).email, auth = await headers()
        expect((await app.inject({ url: `${operatorUrl}?email=${encodeURIComponent(email)}` })).statusCode).toBeGreaterThanOrEqual(400)
        const response = await app.inject({ method: 'POST', url: `${operatorUrl}/issue`, headers: auth, payload: { email, expectedRevision: 0, requestKey: 'http-once' } })
        expect(response.statusCode, response.body).toBe(200)
        const token = new URLSearchParams(new URL(response.json().setupUrl).hash.slice(1)).get('token')!
        const status = await app.inject({ url: `${operatorUrl}?email=${encodeURIComponent(email)}`, headers: auth })
        expect(status.statusCode, status.body).toBe(200); expect(status.json()).toMatchObject({ pending: true, revision: 1 })
        expect(status.body).not.toContain(token); expect(status.body).not.toContain('setupUrl'); expect(status.body).not.toContain('tokenDigest')
        for (const reply of [response, status]) {
            expect(reply.headers['cache-control']).toContain('no-store'); expect(reply.headers['referrer-policy']).toBe('no-referrer')
        }
        const inspected = await app.inject({ method: 'POST', url: `${publicUrl}/inspect`, payload: { token } })
        expect(inspected.statusCode, inspected.body).toBe(200); expect(inspected.json()).toMatchObject({ email, method: 'operator', emailOwnershipVerified: false })
        const completed = await app.inject({ method: 'POST', url: `${publicUrl}/redeem`, payload: { token, password: chosenPassword, fullName: 'HTTP Partner' } })
        expect(completed.statusCode, completed.body).toBe(200); expect(completed.json()).toMatchObject({ completed: true, status: 'awaiting_partner_approval', emailOwnershipVerified: false })
        for (const reply of [inspected, completed]) {
            expect(reply.headers['cache-control']).toBe('no-store'); expect(reply.headers['referrer-policy']).toBe('no-referrer'); expect(reply.body).not.toContain(token); expect(reply.body).not.toContain(chosenPassword)
        }
        expect(await passwordHasher.compare(chosenPassword, (await readTarget()).password)).toBe(true)
        await noAdmission()
    })
    it.each(['client-admin', 'stale', 'unverified', 'rate-limiter-disabled'] as const)('denies%s before operator issue/status can expose a target', async mode => {
        let actor = operator, userId = operatorUserId
        if (mode === 'client-admin') {
            const identityId = await identity(true), home = await onboarding().provision({ identityId, name: 'Client admin', operator }); actor = { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }; userId = home.userId
        }
        if (mode === 'stale') actor = { ...operator, tokenVersion: 'stale' }
        if (mode === 'unverified') await ds.getRepository(UserIdentityEntity).update({ id: operator.identityId }, { verified: false })
        if (mode === 'rate-limiter-disabled') vi.stubEnv('AP_API_RATE_LIMIT_AUTHN_ENABLED', 'false')
        const auth = await headers(actor, userId), email = (await readTarget()).email
        for (const request of [{ url: `${operatorUrl}?email=${encodeURIComponent(email)}` }, { method: 'POST' as const, url: `${operatorUrl}/issue`, payload: { email, expectedRevision: 0, requestKey: 'denied' } }]) {
            const response = await app.inject({ ...request, headers: auth })
            expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400); expect(response.statusCode).toBeLessThan(500)
            expect(response.body).not.toContain(email); expect(response.body).not.toContain('tokenDigest')
        }
        expect(await ds.getRepository(HostingPartnerSetupTokenEntity).count()).toBe(0)
    })
    it('returns the same public error for malformed, unknown, revoked and used links without reflecting tokens or passwords', async () => {
        const link = await issue(), email = (await readTarget()).email
        await service().command({ actor: operator, action: 'revoke', input: { email, expectedRevision: 1, requestKey: 'hide-revoked' } })
        const used = await issue(2, 'used-link')
        await redeem(used.token)
        for (const token of ['malformed', 'X'.repeat(43), link.token, used.token]) {
            for (const endpoint of ['inspect', 'redeem']) {
                const response = await app.inject({ method: 'POST', url: `${publicUrl}/${endpoint}`, payload: endpoint === 'inspect' ? { token } : { token, password: chosenPassword, fullName: 'Denied Partner' } })
                expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(response.statusCode).toBeLessThan(500)
                expect(response.json()).toEqual({ code: 'HOSTING_SETUP_LINK_UNAVAILABLE' })
                expect(response.body).not.toContain(token); expect(response.body).not.toContain(email); expect(response.body).not.toContain(chosenPassword)
            }
        }
    })
    it('rejects caller-supplied authority fields and fails public setup closed when the required rate limiter is disabled', async () => {
        const link = await issue(), auth = await headers(), email = (await readTarget()).email
        const issueResponse = await app.inject({ method: 'POST', url: `${operatorUrl}/issue`, headers: auth, payload: { email, expectedRevision: 1, requestKey: 'extra', verified: true, role: 'partner' } })
        expect(issueResponse.statusCode).toBe(400)
        for (const payload of [{ token: link.token, password: chosenPassword, fullName: 'Caller Name', emailOwnershipVerified: true }, { token: link.token, password: chosenPassword, fullName: 'Caller Name', identityId: operator.identityId }]) {
            const response = await app.inject({ method: 'POST', url: `${publicUrl}/redeem`, payload })
            expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ code: 'HOSTING_SETUP_LINK_UNAVAILABLE' })
        }
        vi.stubEnv('AP_API_RATE_LIMIT_AUTHN_ENABLED', 'false')
        const denied = await app.inject({ method: 'POST', url: `${publicUrl}/redeem`, payload: { token: link.token, password: chosenPassword, fullName: 'Caller Name' } })
        expect(denied.statusCode).toBe(403); expect(denied.json()).toEqual({ code: 'HOSTING_SETUP_LINK_UNAVAILABLE' })
        expect((await readTarget()).verified).toBe(false)
    })
})
