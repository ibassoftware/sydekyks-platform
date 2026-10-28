import { AppConnectionScope, AppConnectionStatus, AppConnectionType, EngineResponseStatus } from '@activepieces/shared'
import fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { find, update, execute, where, andWhere, submit } = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), execute: vi.fn(), where: vi.fn(), andWhere: vi.fn(), submit: vi.fn() }))
vi.mock('../../src/app/app-connection/app-connection-service/app-connection-service', () => ({ appConnectionsRepo: () => ({ findOneBy: find, findOneByOrFail: find, update, createQueryBuilder: () => builder }) }))
vi.mock('../../src/app/database/redis-connections', async importOriginal => ({ ...await importOriginal<typeof import('../../src/app/database/redis-connections')>(), distributedLock: () => ({ runExclusive: ({ fn }: { fn: () => unknown }) => fn() }) }))
vi.mock('../../src/app/helper/encryption', async importOriginal => ({ ...await importOriginal<typeof import('../../src/app/helper/encryption')>(), encryptUtils: { decryptObject: async (value: { plaintext: unknown }) => value.plaintext, encryptObject: async (value: unknown) => ({ plaintext: value }) } }))
vi.mock('../../src/app/pieces/metadata/piece-metadata-service', () => ({ getPiecePackageWithoutArchive: async (_log: unknown, platformId: string, piece: unknown) => ({ ...(piece as object), platformId, packageType: 'REGISTRY', pieceType: 'OFFICIAL' }) }))
vi.mock('../../src/app/workers/user-interaction-watcher', () => ({ userInteractionWatcher: { submitAndWaitForResponse: submit } }))
import { appConnectionHandler } from '../../src/app/app-connection/app-connection-service/app-connection.handler'
const builder = { addSelect: () => builder, getRawAndEntities: async () => {
    const connection = await find(); return { entities: connection ? [connection] : [], raw: connection ? [{ refreshUpdatedAt: connection.updated }] : [] }
}, update: () => builder, set: () => builder, where: (...args: unknown[]) => {
    where(...args); return builder
}, andWhere: (...args: unknown[]) => {
    andWhere(...args); return builder
}, returning: () => builder, execute }
const log = fastify().log
function row() {
    return { id: 'connection', platformId: 'platform', projectIds: ['project'], externalId: 'scoped-key', ownerId: 'owner', created: new Date().toISOString(), updated: new Date().toISOString(), displayName: 'Client connection', pieceName: '@activepieces/piece-slack', pieceVersion: '0.1.0', type: AppConnectionType.CUSTOM_AUTH, scope: AppConnectionScope.PROJECT, status: AppConnectionStatus.ACTIVE, value: { plaintext: { type: AppConnectionType.CUSTOM_AUTH, props: { secret: 'synthetic-old' }, access_token: 'stale', token_refresh_at: 0 } } }
}
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    find.mockResolvedValue(row()); execute.mockResolvedValue({ raw: [{ id: 'connection' }] })
    submit.mockResolvedValue({ status: EngineResponseStatus.OK, response: { skipped: false, access_token: 'synthetic-refreshed', expires_in: 3600 } })
})
afterEach(() => vi.unstubAllEnvs())
describe('hosted connection refresh return and revision boundaries', () => {
    it.each(['rotation', 'unshare'])('rejects an in-flight %s without overwriting or returning old credentials', async () => {
        let release!: (value: unknown) => void
        submit.mockImplementationOnce(() => new Promise(resolve => {
            release = resolve
        }))
        execute.mockResolvedValueOnce({ raw: [] })
        const original = row(); find.mockResolvedValue(original)
        const result = appConnectionHandler(log).lockAndRefreshConnection({ platformId: 'platform', projectId: 'project', externalId: 'scoped-key', log, parentAdmissionId: 'running-admission' })
        await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
        release({ status: EngineResponseStatus.OK, response: { skipped: false, access_token: 'synthetic-refreshed', expires_in: 3600 } })
        await expect(result).rejects.toThrow('HOSTING_CONNECTION_REVISION_MISMATCH')
        expect(where).toHaveBeenCalledWith(expect.objectContaining({ id: 'connection', platformId: 'platform', projectIds: expect.anything() }))
        expect(andWhere).toHaveBeenCalledWith('updated = CAST(:originalUpdatedAt AS timestamptz)', { originalUpdatedAt: original.updated })
        expect(andWhere).toHaveBeenCalledWith('value = CAST(:originalValue AS jsonb)', { originalValue: JSON.stringify(original.value) })
        expect(update).not.toHaveBeenCalled()
    })
    it('rejects provider failure without a bare-id error mutation or stale credential fallback', async () => {
        submit.mockResolvedValueOnce({ status: EngineResponseStatus.USER_FAILURE, error: 'synthetic refresh refusal' })
        await expect(appConnectionHandler(log).lockAndRefreshConnection({ platformId: 'platform', projectId: 'project', externalId: 'scoped-key', log, parentAdmissionId: 'running-admission' })).rejects.toThrow('Custom auth token refresh failed')
        expect(update).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
    })
    it('refuses a missing user/parent origin before any worker refresh', async () => {
        await expect(appConnectionHandler(log).lockAndRefreshConnection({ platformId: 'platform', projectId: 'project', externalId: 'scoped-key', log })).rejects.toThrow('HOSTING_CONNECTION_PROVENANCE_REQUIRED')
        expect(submit).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
    })
    it('does not return old credentials on an uncertain timeout', async () => {
        submit.mockResolvedValueOnce({ status: EngineResponseStatus.TIMEOUT })
        await expect(appConnectionHandler(log).lockAndRefreshConnection({ platformId: 'platform', projectId: 'project', externalId: 'scoped-key', log, parentAdmissionId: 'running-admission' })).rejects.toThrow('HOSTING_CONNECTION_REFRESH_OUTCOME_UNCERTAIN')
        expect(update).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
    })
})
