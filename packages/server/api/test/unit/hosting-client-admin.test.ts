import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { ClientProfileInput, createHostedClientAdmin, hostedAccountKind } from '../../src/app/hosting/hosting-client-admin'
import { HostingAccountEntity, HostingOutboxEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { PlatformEntity } from '../../src/app/platform/platform.entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, operator: HostingActor, owner: HostingActor
const admin = () => createHostedClientAdmin({ dataSource: ds })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, provider: 'EMAIL', password: 'unused-fixture', verified: true, firstName: 'Client', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
beforeAll(async () => { ds = await migratedHostedPGlite() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-client-service-fixture-at-least32' })
    const operatorId = await identity(), home = await bootstrapHostedOperator(ds, onboarding, operatorId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', operatorId)
    operator = { identityId: operatorId, platformId: home.platformId, tokenVersion: home.tokenVersion }
    const ownerId = await identity(), client = await onboarding.provision({ identityId: ownerId, name: 'Moonlight Bakery', operator })
    owner = { identityId: ownerId, platformId: client.platformId, tokenVersion: client.tokenVersion }
    await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'starter' })
})
describe('persistent operator client management', () => {
    it('returns client context without secrets and atomically audits profile changes without touching financial rows', async () => {
        const before = await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: owner.platformId })
        const current = await admin().read({ actor: operator, platformId: owner.platformId })
        expect(current.client).toMatchObject({ name: 'Moonlight Bakery', owner: { identityId: owner.identityId }, limits: { users: 10, concurrency: 2 }, partners: [] })
        expect(current.client).not.toHaveProperty('password')
        const changed = await admin().rename({ actor: operator, platformId: owner.platformId, input: { name: 'Moonlight Bakery Test', expectedState: current.client.stateHash, reason: 'Correct test company name', confirmed: true } })
        expect(changed.client.name).toBe('Moonlight Bakery Test')
        expect(changed.client.stateHash).not.toBe(current.client.stateHash)
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: owner.platformId })).toEqual(before)
        const audit = await ds.getRepository(HostingOutboxEntity).findBy({ platformId: owner.platformId, event: 'client.profile.updated' })
        expect(audit).toHaveLength(1)
        await expect(admin().rename({ actor: operator, platformId: owner.platformId, input: { name: 'Stale update', expectedState: current.client.stateHash, reason: 'Stale request', confirmed: true } })).rejects.toThrow('HOSTING_CLIENT_REVISION_CONFLICT')
        expect((await ds.getRepository(PlatformEntity).findOneByOrFail({ id: owner.platformId })).name).toBe('Moonlight Bakery Test')
    })
    it('denies client administrators and stale operator sessions', async () => {
        await expect(admin().read({ actor: owner, platformId: owner.platformId })).rejects.toThrow('HOSTING_OPERATOR_REQUIRED')
        await expect(admin().read({ actor: { ...operator, tokenVersion: 'stale' }, platformId: owner.platformId })).rejects.toThrow('HOSTING_OPERATOR_REQUIRED')
    })
    it('does not treat Partner hosting or trials as clients', async () => {
        for (const planId of ['training', 'assessment', 'trial'] as const) {
            await ds.getRepository(HostingAccountEntity).update({ id: owner.platformId }, { planId })
            await expect(admin().read({ actor: operator, platformId: owner.platformId })).rejects.toThrow('HOSTING_CLIENT_UNAVAILABLE')
        }
        expect(['starter', 'team', 'scale'].map(hostedAccountKind)).toEqual(['client', 'client', 'client'])
    })
    it('requires an explicit confirmation, audit reason and bounded profile input', () => {
        const valid = { name: 'Client', expectedState: 'a'.repeat(64), reason: 'Audit reason', confirmed: true }
        for (const invalid of [{ ...valid, confirmed: false }, { ...valid, reason: ' ' }, { ...valid, name: ' ' }, { ...valid, name: 'x'.repeat(121) }, { ...valid, planId: 'scale' }]) expect(ClientProfileInput.safeParse(invalid).success).toBe(false)
    })
})
