import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { passwordHasher } from '../../src/app/authentication/lib/password-hasher'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { createHostedRecovery } from '../../src/app/hosting/hosting-account-recovery'
import { HostingGrantEntity, HostingOutboxEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { setHostedUserPassword } from '../../src/app/hosting/hosting-password'
import { HostingRecoveryTokenEntity } from '../../src/app/hosting/hosting-recovery-entities'
import { HostingTrainerRoleEntity } from '../../src/app/hosting/hosting-trainer-entities'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, operator: HostingActor, target: string
const password = 'Synthetic-chosen-password-42!'
const service = () => createHostedRecovery({ dataSource: ds })
async function identity(verified = true) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id.toLowerCase()}@test.invalid`, provider: 'EMAIL', password: await passwordHasher.hash('Synthetic-old-password-71!'), verified, firstName: 'Recovery', lastName: 'Fixture', tokenVersion: 'original' })
    return id
}
async function input(requestKey = apId(), identityId = target) {
    const recipient = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
    const state = await service().status({ actor: operator, email: recipient.email })
    return { email: recipient.email, expectedRevision: state.revision, expectedState: state.stateHash, requestKey, identityVerificationConfirmed: true as const, verificationReason: 'Participant lost access to their account', verificationEvidence: 'Identity checked in scheduled existing client video call' }
}
async function issue() {
    const value = await input(), result = await service().command({ actor: operator, input: value, action: 'issue' })
    const token = new URLSearchParams(new URL(result.setupUrl!).hash.slice(1)).get('token')!
    return { value, result, token }
}
beforeAll(async () => {
    ds = await migratedHostedPGlite() 
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy() 
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', ''); vi.stubEnv('AP_FRONTEND_URL', 'https://pilot.test.invalid')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const id = await identity(), onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-recovery-fixture-secret-atleast32chars' }), home = await bootstrapHostedOperator(ds, onboarding, id)
    operator = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }; target = await identity()
})
it('uses a private 30-minute digest capability, rotates credentials once and preserves grants and identity permissions', async () => {
    const before = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target }), grants = await ds.getRepository(HostingGrantEntity).find()
    const started = Date.now(), link = await issue(), row = await ds.getRepository(HostingRecoveryTokenEntity).findOneByOrFail({ identityId: target })
    expect(row.tokenDigest).toBe(createHash('sha256').update(link.token).digest('hex'))
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(started + 1800000)
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1800000)
    expect(JSON.stringify(row)).not.toContain(link.token)
    expect(new URL(link.result.setupUrl!).pathname).toBe('/account-recovery')
    expect(await service().command({ actor: operator, input: link.value, action: 'issue' })).toMatchObject({ replayed: true, setupUrl: null })
    await service().redeem({ token: link.token, password })
    const after = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
    expect(after.tokenVersion).not.toBe(before.tokenVersion)
    expect(await passwordHasher.compare(password, after.password)).toBe(true)
    expect(after).toMatchObject({ email: before.email, firstName: before.firstName, lastName: before.lastName, verified: true })
    expect(await ds.getRepository(HostingGrantEntity).find()).toEqual(grants)
    expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: target })).toBe(0)
    await expect(service().redeem({ token: link.token, password })).rejects.toThrow('LINK_UNAVAILABLE')
})
it('enforces target-state CAS, replacement revocation and immutable audit evidence', async () => {
    const stale = await input(), first = await issue()
    await expect(service().command({ actor: operator, input: stale, action: 'issue' })).rejects.toThrow('REVISION_CONFLICT')
    const second = await issue()
    await expect(service().inspect(first.token)).rejects.toThrow('LINK_UNAVAILABLE')
    await expect(ds.getRepository(HostingRecoveryTokenEntity).update({ identityId: target, revision: 1 }, { verificationEvidence: 'rewritten history' })).rejects.toThrow('HISTORY_IMMUTABLE')
    await service().command({ actor: operator, input: await input(), action: 'revoke' })
    await expect(service().inspect(second.token)).rejects.toThrow('LINK_UNAVAILABLE')
})
it.each(['self', 'operator', 'team', 'trainer', 'unverified'] as const)('protects %s accounts from the recovery channel', async kind => {
    if (kind === 'self') target = operator.identityId
    if (kind === 'operator') vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', `${operator.identityId},${target}`)
    if (kind === 'team') await ds.getRepository(HostingAccessRoleEntity).insert({ id: target, role: 'team', active: false })
    if (kind === 'trainer') await ds.getRepository(HostingTrainerRoleEntity).insert({ id: target, active: false, accessVersion: 1, revision: 1 })
    if (kind === 'unverified') await ds.getRepository(UserIdentityEntity).update({ id: target }, { verified: false })
    const value = await input()
    await expect(service().command({ actor: operator, input: value, action: 'issue' })).rejects.toThrow('ACCOUNT_UNAVAILABLE')
    expect(await ds.getRepository(HostingRecoveryTokenEntity).count()).toBe(0)
})
it.each(['issuer-session', 'issuer-allowlist', 'target-session'] as const)('invalidates copied links after %s changes', async kind => {
    const link = await issue()
    if (kind === 'issuer-session') await ds.getRepository(UserIdentityEntity).update({ id: operator.identityId }, { tokenVersion: 'rotated' })
    if (kind === 'issuer-allowlist') vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    if (kind === 'target-session') await ds.getRepository(UserIdentityEntity).update({ id: target }, { tokenVersion: 'rotated' })
    await expect(service().redeem({ token: link.token, password })).rejects.toThrow()
    expect((await ds.getRepository(HostingRecoveryTokenEntity).findOneByOrFail({ identityId: target })).usedAt).toBeNull()
})
it('commits one completion when the same copied link is redeemed twice', async () => {
    const link = await issue(), outcomes = await Promise.allSettled([service().redeem({ token: link.token, password }), service().redeem({ token: link.token, password })])
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
})

it('lets only a reauthenticated current operator change ordinary and privileged account passwords, recording an audit event', async () => {
    const recipient = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
    const input = { email: recipient.email, currentPassword: 'Synthetic-old-password-71!', newPassword: password, reason: 'Founder authorized account password correction' }
    await expect(setHostedUserPassword({ dataSource: ds, actor: operator, input: { ...input, currentPassword: 'wrong-password' } })).rejects.toThrow()
    await expect(setHostedUserPassword({ dataSource: ds, actor: { ...operator, tokenVersion: 'stale' }, input })).rejects.toThrow()
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', target)
    await expect(setHostedUserPassword({ dataSource: ds, actor: operator, input })).rejects.toThrow()
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', [operator.identityId, target].join(','))
    await setHostedUserPassword({ dataSource: ds, actor: operator, input })
    const changed = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })
    expect(await passwordHasher.compare(password, changed.password)).toBe(true)
    expect(changed.tokenVersion).not.toBe(recipient.tokenVersion)
    const events = await ds.getRepository(HostingOutboxEntity).findBy({ event: 'identity.password.admin_changed' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ actorIdentityId: operator.identityId, identityId: target, reason: input.reason })
    expect(JSON.stringify(events)).not.toContain(password)
    expect(JSON.stringify(events)).not.toContain(input.currentPassword)
})
it('allows the platform operator to change their own password and invalidates their previous operator session', async () => {
    const identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: operator.identityId })
    const input = { email: identity.email, currentPassword: 'Synthetic-old-password-71!', newPassword: password, reason: 'Operator requested password rotation' }
    await setHostedUserPassword({ dataSource: ds, actor: operator, input })
    await expect(service().status({ actor: operator, email: identity.email })).rejects.toThrow()
})
