import { AppConnectionScope, AppConnectionType } from '@activepieces/shared'
import fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { metadata, resolve, revalidate } = vi.hoisted(() => ({ metadata: vi.fn(), resolve: vi.fn(), revalidate: vi.fn() }))
vi.mock('../../src/app/pieces/metadata/piece-metadata-service', () => ({ pieceMetadataService: () => ({ getOrThrow: metadata }) }))
vi.mock('../../src/app/sydekyks-community/connection-values', () => ({ containsSecretManagerReference: () => false, secretManagersService: () => ({ resolveObject: resolve }) }))
vi.mock('../../src/app/app-connection/app-connection-service/app-connection.handler', () => ({ appConnectionHandler: () => ({ revalidateConnection: revalidate }) }))
import { appConnectionService } from '../../src/app/app-connection/app-connection-service/app-connection-service'
const log = fastify().log
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('AP_SERVICE_MODE', 'hosted') 
})
afterEach(() => vi.unstubAllEnvs())
it('refuses a service or missing principal before resolving secrets or validating an upsert', async () => {
    await expect(appConnectionService(log).upsert({ platformId: 'platform', projectIds: ['project'], ownerId: 'owner', scope: AppConnectionScope.PROJECT, externalId: 'external', displayName: 'Connection', pieceName: '@activepieces/piece-slack', type: AppConnectionType.SECRET_TEXT, value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'synthetic-client-key' } })).rejects.toThrow('HOSTING_USER_PRINCIPAL_REQUIRED')
    expect(metadata).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled()
})
it('refuses a service or missing principal before connection lookup and revalidation refresh', async () => {
    await expect(appConnectionService(log).revalidate({ id: 'connection', platformId: 'platform', projectId: 'project' })).rejects.toThrow('HOSTING_USER_PRINCIPAL_REQUIRED')
    expect(revalidate).not.toHaveBeenCalled(); expect(metadata).not.toHaveBeenCalled()
})
