import { apId } from '@activepieces/core-utils'
import { AppConnectionScope, AppConnectionStatus, AppConnectionType } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistConnectionRefresh, readConnectionRefreshSnapshot } from '../../src/app/app-connection/app-connection-service/connection-refresh-snapshot'
import { AppConnectionEntity } from '../../src/app/app-connection/app-connection.entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource
beforeAll(async () => {
    ds = await migratedHostedPGlite()
})
afterAll(async () => {
    await ds.destroy()
})
beforeEach(() => vi.stubEnv('AP_SERVICE_MODE', 'hosted'))
afterEach(() => vi.unstubAllEnvs())
async function fixture() {
    const repository = ds.getRepository(AppConnectionEntity)
    const row = await repository.save({ id: apId(), platformId: apId(), projectIds: [apId()], externalId: apId(), ownerId: null, displayName: 'Synthetic precision fixture', pieceName: '@activepieces/piece-gmail', pieceVersion: '0.1.0', type: AppConnectionType.OAUTH2, scope: AppConnectionScope.PROJECT, status: AppConnectionStatus.ACTIVE, value: await encryptUtils.encryptObject({ type: AppConnectionType.OAUTH2, access_token: 'synthetic-stale', refresh_token: 'synthetic-refresh' }), preSelectForNewProjects: false })
    await ds.query('UPDATE app_connection SET updated = $1::timestamptz WHERE id = $2', ['2026-10-28T12:52:42.080758Z', row.id])
    const snapshot = await readConnectionRefreshSnapshot(repository, { id: row.id, platformId: row.platformId })
    const refreshed = { ...snapshot.connection!, value: { type: AppConnectionType.OAUTH2, access_token: 'synthetic-fresh', refresh_token: 'synthetic-refresh' } } as never
    return { repository, snapshot, refreshed, row, projectId: row.projectIds[0] }
}
describe('exact PostgreSQL refresh revision fencing', () => {
    it('persists an unchanged microsecond revision that a JavaScript Date equality rejects', async () => {
        const f = await fixture()
        expect(String(f.snapshot.updatedAt)).toContain('080758')
        const oldComparison = await f.repository.createQueryBuilder().update().set({ status: AppConnectionStatus.ACTIVE }).where({ id: f.row.id, updated: f.snapshot.connection!.updated }).returning(['id']).execute()
        expect(oldComparison.raw).toEqual([])
        await persistConnectionRefresh(f.repository, f.snapshot, f.refreshed, f.projectId)
        const current = await f.repository.findOneByOrFail({ id: f.row.id })
        expect(await encryptUtils.decryptObject(current.value)).toMatchObject({ access_token: 'synthetic-fresh', refresh_token: 'synthetic-refresh' })
    })
    it('rejects a competing revision one microsecond later within the same millisecond', async () => {
        const f = await fixture()
        await ds.query('UPDATE app_connection SET updated = $1::timestamptz WHERE id = $2', ['2026-10-28T12:52:42.080759Z', f.row.id])
        await expect(persistConnectionRefresh(f.repository, f.snapshot, f.refreshed, f.projectId)).rejects.toThrow('HOSTING_CONNECTION_REVISION_MISMATCH')
        expect(await encryptUtils.decryptObject((await f.repository.findOneByOrFail({ id: f.row.id })).value)).toMatchObject({ access_token: 'synthetic-stale' })
    })
    it.each(['rotation', 'unshare'])('preserves a concurrent %s instead of saving the stale refresh', async change => {
        const f = await fixture()
        if (change === 'rotation') await f.repository.update(f.row.id, { value: await encryptUtils.encryptObject({ type: AppConnectionType.OAUTH2, access_token: 'synthetic-replacement' }) })
        else await f.repository.update(f.row.id, { projectIds: [] })
        await expect(persistConnectionRefresh(f.repository, f.snapshot, f.refreshed, f.projectId)).rejects.toThrow('HOSTING_CONNECTION_REVISION_MISMATCH')
        const current = await f.repository.findOneByOrFail({ id: f.row.id })
        if (change === 'rotation') expect(await encryptUtils.decryptObject(current.value)).toMatchObject({ access_token: 'synthetic-replacement' })
        else expect(current.projectIds).toEqual([])
    })
})
