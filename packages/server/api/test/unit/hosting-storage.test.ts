import { Readable } from 'node:stream'
import { apId } from '@activepieces/core-utils'
import { FileCompression, FileType } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FileEntity } from '../../src/app/file/file.entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccountEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { cleanupHostedFiles, hostedFileBytes, hostedStorageUsage, saveHostedFile } from '../../src/app/hosting/hosting-storage'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, actor: HostingActor, projectId: string
const MiB = 1024 * 1024
const base = (id = apId(), type = FileType.FLOW_STEP_FILE) => ({ id, projectId, platformId: actor.platformId, type, fileName: 'synthetic.txt', compression: FileCompression.NONE, size: 1, metadata: null, created: new Date(0).toISOString(), updated: new Date().toISOString() })
beforeAll(async () => {
    ds = await migratedHostedPGlite() 
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy() 
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted'); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', ''); vi.stubEnv('AP_HOSTED_STORAGE_LIMITS_JSON', JSON.stringify({ trial: MiB, global: MiB * 2 })); vi.stubEnv('AP_MAX_FILE_SIZE_MB', '1')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id.toLowerCase()}@test.invalid`, provider: 'EMAIL', password: 'synthetic-unused', verified: true, firstName: 'Storage', lastName: 'Test' })
    const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-storage-secret-at-least32characters' }), id)
    actor = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }; projectId = home.projectId
})
it('counts actual retained bytes, replaces atomically, rejects scope changes and leaves old data readable at capacity', async () => {
    const file = base(), content = Buffer.alloc(MiB, 1)
    await saveHostedFile(ds, file, content)
    expect(await hostedStorageUsage(ds.manager, actor.platformId)).toEqual({ own: MiB, total: MiB })
    await expect(saveHostedFile(ds, base(), Buffer.from('overflow'))).rejects.toThrow('STORAGE_LIMIT')
    await expect(saveHostedFile(ds, { ...file, projectId: null }, Buffer.alloc(0))).rejects.toThrow('SCOPE_CONFLICT')
    expect((await ds.getRepository(FileEntity).findOneByOrFail({ id: file.id })).data).toEqual(content)
    await saveHostedFile(ds, file, Buffer.from('smaller'))
    expect((await hostedStorageUsage(ds.manager, actor.platformId)).own).toBe(7)
})
it('bounds actual streams and buffers independently of client size claims', async () => {
    expect(await hostedFileBytes(Readable.from([Buffer.from('a'), Buffer.from('bc')]))).toEqual(Buffer.from('abc'))
    await expect(hostedFileBytes(Readable.from([Buffer.alloc(MiB), Buffer.from('x')]))).rejects.toThrow('FILE_TOO_LARGE')
    await expect(hostedFileBytes(Buffer.alloc(MiB + 1))).rejects.toThrow('FILE_TOO_LARGE')
    await expect(hostedFileBytes(null)).rejects.toThrow('FILE_DATA_REQUIRED')
})
it('reclaims aged terminal-project temporary files while retaining durable and unsettled-root files', async () => {
    const temporary = base(), durable = base(apId(), FileType.SAMPLE_DATA)
    await saveHostedFile(ds, temporary, Buffer.from('temp')); await saveHostedFile(ds, durable, Buffer.from('sample'))
    const root = await createHostedLedger({ dataSource: ds }).reserveExecution({ actor, projectId, key: 'keep-paused', payer: 'byok' })
    expect(await cleanupHostedFiles(ds, [FileType.FLOW_STEP_FILE, FileType.SAMPLE_DATA], 1)).toBe(0)
    await ds.getRepository(HostingReservationEntity).update({ id: root.id }, { state: 'settled' })
    expect(await cleanupHostedFiles(ds, [FileType.FLOW_STEP_FILE, FileType.SAMPLE_DATA], 1)).toBe(1)
    expect(await ds.getRepository(FileEntity).existsBy({ id: durable.id })).toBe(true)
})
it('stops only new execution admission at the limit; idempotent roots and shrinking files remain usable', async () => {
    const ledger = createHostedLedger({ dataSource: ds }), root = await ledger.reserveExecution({ actor, projectId, key: 'existing', payer: 'byok' }), file = base()
    await saveHostedFile(ds, file, Buffer.alloc(MiB))
    expect((await ledger.reserveExecution({ actor, projectId, key: 'existing', payer: 'byok' })).id).toBe(root.id)
    await expect(ledger.reserveExecution({ actor, projectId, key: 'new', payer: 'byok' })).rejects.toThrow('STORAGE_LIMIT')
    expect(await ds.getRepository(HostingReservationEntity).count()).toBe(1)
    await saveHostedFile(ds, file, Buffer.alloc(0))
    expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).activeExecutions).toBe(1)
})
