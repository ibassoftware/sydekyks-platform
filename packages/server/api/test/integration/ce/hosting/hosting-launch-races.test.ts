import { randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { FileCompression, FileType } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../../../src/app/authentication/user-identity/user-identity-entity'
import { commonProperties } from '../../../../src/app/database/database-connection'
import { getMigrations } from '../../../../src/app/database/postgres-connection'
import { FileEntity } from '../../../../src/app/file/file.entity'
import { FlagEntity } from '../../../../src/app/flags/flag.entity'
import { createHostedRecovery } from '../../../../src/app/hosting/hosting-account-recovery'
import { INSTALLATION_MODE_FLAG_ID } from '../../../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../../../src/app/hosting/hosting-onboarding'
import { cleanupHostedFiles, saveHostedFile } from '../../../../src/app/hosting/hosting-storage'
import { HostingActor } from '../../../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator } from '../../../helpers/hosting-fixtures'

if (!process.env['HOSTING_TEST_POSTGRES_PORT']) throw new Error('Explicit disposable PostgreSQL port required')
const schema = `hosting_launch_${randomBytes(6).toString('hex')}`
const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(process.env['HOSTING_TEST_POSTGRES_PORT']), username: process.env['HOSTING_TEST_POSTGRES_USER'] ?? 'sydekyks_ci', password: process.env['HOSTING_TEST_POSTGRES_PASSWORD'] ?? 'disposable-ci-only', database: process.env['HOSTING_TEST_POSTGRES_DATABASE'] ?? 'sydekyks_ci', schema, extra: { options: `-c search_path=${schema},public` }, migrations: getMigrations(), ...commonProperties })
let actor: HostingActor, projectId: string
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id.toLowerCase()}@test.invalid`, provider: 'EMAIL', password: 'synthetic-unused', verified: true, firstName: 'Launch', lastName: 'Race', tokenVersion: 'initial' })
    return id
}
beforeAll(async () => {
    await ds.initialize(); await ds.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
    const runner = ds.createQueryRunner()
    try {
        await runner.createSchema(schema, true) 
    }
    finally {
        await runner.release() 
    }
    await ds.runMigrations({ transaction: 'each' })
})
afterAll(async () => {
    if (ds.isInitialized) {
        await ds.query(`DROP SCHEMA "${schema}" CASCADE`); await ds.destroy() 
    } 
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', ''); vi.stubEnv('AP_FRONTEND_URL', 'https://synthetic.test.invalid')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${schema}"."${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const id = await identity(), home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-launch-race-secret-atleast32characters' }), id)
    actor = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }; projectId = home.projectId!
})
it('serializes temporary-file cleanup behind admitted roots without deleting their retained data', async () => {
    const file = { id: apId(), platformId: actor.platformId, projectId, type: FileType.FLOW_STEP_FILE, compression: FileCompression.NONE, metadata: null, fileName: 'test', size: 0, created: new Date(0).toISOString(), updated: new Date().toISOString() }
    await saveHostedFile(ds, file, Buffer.from('keep while admitted'))
    const runner = ds.createQueryRunner(); await runner.connect(); await runner.startTransaction()
    let cleanup: Promise<number> | undefined
    try {
        await createHostedLedger({ dataSource: ds, manager: runner.manager }).reserveExecution({ actor, projectId, key: 'admission-before-cleanup', payer: 'byok' })
        let completed = false
        cleanup = cleanupHostedFiles(ds, [FileType.FLOW_STEP_FILE], 1).then(value => {
            completed = true; return value 
        })
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(completed).toBe(false)
        await runner.commitTransaction()
        expect(await cleanup).toBe(0)
        expect(await ds.getRepository(FileEntity).existsBy({ id: file.id })).toBe(true)
    }
    finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); if (cleanup) await cleanup 
    }
})
it('cannot exceed the byte cap with simultaneous uploads', async () => {
    vi.stubEnv('AP_HOSTED_STORAGE_LIMITS_JSON', JSON.stringify({ trial: 1048576 }))
    const write = () => saveHostedFile(ds, { id: apId(), platformId: actor.platformId, projectId, type: FileType.SAMPLE_DATA, compression: FileCompression.NONE, metadata: null, fileName: 'test', size: 0, created: new Date().toISOString(), updated: new Date().toISOString() }, Buffer.alloc(700000))
    const outcomes = await Promise.allSettled([write(), write()])
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect(await ds.getRepository(FileEntity).count()).toBe(1)
})
it('redeems a recovery capability once under real PostgreSQL row locking', async () => {
    const target = await identity(), email = (await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: target })).email, service = createHostedRecovery({ dataSource: ds })
    const state = await service.status({ actor, email }), issued = await service.command({ actor, action: 'issue', input: { email, expectedRevision: state.revision, expectedState: state.stateHash, requestKey: 'recovery-race', identityVerificationConfirmed: true, verificationReason: 'Synthetic account lost access', verificationEvidence: 'Synthetic trusted-contact verification' } })
    const token = new URLSearchParams(new URL(issued.setupUrl!).hash.slice(1)).get('token')!
    const outcomes = await Promise.allSettled([service.redeem({ token, password: 'Synthetic-new-password-51!' }), service.redeem({ token, password: 'Synthetic-other-password-74!' })])
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
})
