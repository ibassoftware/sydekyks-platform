import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource
beforeAll(async () => {
    ds = await migratedHostedPGlite()
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})

it('applies actual additive migrations on PGlite and preserves identity and immutable credit history', async () => {
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: 'pglite@example.com', provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Owner' })
    expect(await ds.getRepository(UserIdentityEntity).existsBy({ id: identityId })).toBe(true)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'self_hosted' } })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-pglite-secret-at-least-32-characters' })
    await expect(onboarding.provision({ identityId, name: 'Tenant' })).rejects.toThrow('HOSTED_INSTALLATION_REQUIRED')
    await ds.getRepository(FlagEntity).update({ id: INSTALLATION_MODE_FLAG_ID }, { value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const tenant = await bootstrapHostedOperator(ds, onboarding, identityId)
    const balance = await createHostedLedger({ dataSource: ds }).balance({ actor: { identityId, platformId: tenant.platformId } })
    expect(balance.find(value => value.meter === 'managed_ai')?.available).toBe(1000000n)
    const entry = await ds.getRepository(HostingLedgerEntity).findOneByOrFail({ platformId: tenant.platformId })
    await expect(ds.getRepository(HostingLedgerEntity).update({ id: entry.id }, { amount: 0n })).rejects.toThrow('HOSTING_LEDGER_IMMUTABLE')
    await expect(ds.getRepository(HostingLedgerEntity).delete({ id: entry.id })).rejects.toThrow('HOSTING_LEDGER_IMMUTABLE')
})
