import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { SydekyksHostingLedger1882000000000 } from '../../src/app/database/migration/postgres/1882000000000-SydekyksHostingLedger'
import { createPGliteDataSource } from '../../src/app/database/pglite-connection'
import { SydekyksHostingDispatch1883000000000 } from '../../src/app/database/migration/postgres/1883000000000-SydekyksHostingDispatch'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'

let ds: DataSource
beforeAll(async () => { ds = createPGliteDataSource(); await ds.initialize() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })

it('applies and rolls back additive schema on PGlite while preserving legacy data', async () => {
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: 'pglite@example.com', provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Owner' })
    const runner = ds.createQueryRunner()
    const migration = new SydekyksHostingLedger1882000000000()
    try {
        await runner.startTransaction()
        await runner.query("CREATE FUNCTION hosting_reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'HOSTING_LEDGER_IMMUTABLE'; END $$")
        await new SydekyksHostingDispatch1883000000000().down(runner)
        await migration.down(runner)
        await migration.up(runner)
        await new SydekyksHostingDispatch1883000000000().up(runner)
        await runner.commitTransaction()
    }
    finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release() }
    expect(await ds.getRepository(UserIdentityEntity).existsBy({ id: identityId })).toBe(true)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'self_hosted' } })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-pglite-secret-at-least-32-characters' })
    await expect(onboarding.provision({ identityId, name: 'Tenant' })).rejects.toThrow('HOSTED_INSTALLATION_REQUIRED')
    await ds.getRepository(FlagEntity).update({ id: INSTALLATION_MODE_FLAG_ID }, { value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const tenant = await onboarding.provision({ identityId, name: 'Tenant' })
    const balance = await createHostedLedger({ dataSource: ds }).balance({ actor: { identityId, platformId: tenant.platformId } })
    expect(balance.find(value => value.meter === 'managed_ai')?.available).toBe(1000000n)
    const entry = await ds.getRepository(HostingLedgerEntity).findOneByOrFail({ platformId: tenant.platformId })
    await expect(ds.getRepository(HostingLedgerEntity).update({ id: entry.id }, { amount: 0n })).rejects.toThrow('HOSTING_LEDGER_IMMUTABLE')
    await expect(ds.getRepository(HostingLedgerEntity).delete({ id: entry.id })).rejects.toThrow('HOSTING_LEDGER_IMMUTABLE')
})
