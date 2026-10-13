import { safeHttp } from '@activepieces/server-utils'
import { PieceSyncMode } from '@activepieces/shared'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pieceSyncService } from '../../src/app/pieces/piece-sync-service'

const mocks = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn(), invalidate: vi.fn() }))
vi.mock('../../src/app/helper/system/system', () => ({ system: { get: () => PieceSyncMode.OFFICIAL_AUTO, getEdition: () => 'ce' } }))
vi.mock('../../src/app/pieces/metadata/piece-metadata-service', () => ({ pieceRepos: () => ({ find: mocks.find }), pieceMetadataService: () => ({ create: mocks.create, bulkDelete: vi.fn() }) }))
vi.mock('../../src/app/pieces/metadata/piece-cache', () => ({ pieceCache: () => ({ invalidate: mocks.invalidate }) }))
vi.mock('../../src/app/helper/promise-handler', () => ({ rejectedPromiseHandler: vi.fn() }))
vi.mock('../../src/app/helper/system-jobs/job-handlers', () => ({ systemJobHandlers: {} }))
vi.mock('../../src/app/helper/system-jobs/system-job', () => ({ systemJobsSchedule: vi.fn() }))
vi.mock('../../src/app/tool-search/tool-search-flag', () => ({ isToolSearchEnabled: () => false }))
vi.mock('../../src/app/tool-search/tool-search-reindex.job', () => ({ toolSearchReindexJob: vi.fn() }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('public integration synchronization', () => {
    it('continues after one failed fetch and accepts nullable upstream metadata fields', async () => {
        const app = Fastify({ logger: false })
        mocks.find.mockResolvedValue([])
        mocks.create.mockResolvedValue({})
        mocks.invalidate.mockResolvedValue(undefined)
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [{ name: '@activepieces/broken', version: '1.0.0' }, { name: '@activepieces/working', version: '1.0.0' }] }))
        vi.spyOn(safeHttp.axios, 'get').mockRejectedValueOnce(new Error('Unavailable integration')).mockResolvedValueOnce({ data: { name: '@activepieces/working', version: '1.0.0', packageType: 'REGISTRY', pieceType: 'OFFICIAL', platformId: null, auth: null, actions: { action: { props: { legacy: { type: 'STATIC_DROPDOWN' } } } } } })
        await pieceSyncService(app.log).sync({ publishCacheRefresh: false })
        expect(mocks.create).toHaveBeenCalledOnce()
        expect(mocks.create.mock.calls[0][0].pieceMetadata.name).toBe('@activepieces/working')
        expect(mocks.invalidate).toHaveBeenCalledOnce()
        await app.close()
    })
})
