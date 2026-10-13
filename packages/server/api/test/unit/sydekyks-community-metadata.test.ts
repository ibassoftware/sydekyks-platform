import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { PlatformRole, PrincipalType, ProjectType, UserStatus } from '@activepieces/shared'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticationMiddleware } from '../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { pieceModule } from '../../src/app/pieces/metadata/piece-metadata-controller'

const services = vi.hoisted(() => ({ project: vi.fn(), user: vi.fn(), principal: vi.fn(), list: vi.fn() }))
vi.mock('../../src/app/project/project-service', () => ({ projectService: () => ({ getOne: services.project }) }))
vi.mock('../../src/app/user/user-service', () => ({ userService: () => ({ get: services.user }) }))
vi.mock('../../src/app/authentication/lib/access-token-manager', () => ({ accessTokenManager: () => ({ verifyPrincipal: services.principal }) }))
vi.mock('../../src/app/sydekyks-community/piece-visibility', () => ({ resolveVisibility: async () => null }))
vi.mock('../../src/app/flows/flow/flow.service', () => ({ flowService: vi.fn() }))
vi.mock('../../src/app/flows/step-run/sample-data.service', () => ({ sampleDataService: vi.fn() }))
vi.mock('../../src/app/workers/user-interaction-watcher', () => ({ userInteractionWatcher: {} }))
vi.mock('../../src/app/pieces/piece-sync-service', () => ({ pieceSyncService: vi.fn() }))
vi.mock('../../src/app/pieces/metadata/piece-metadata-service', () => ({ pieceMetadataService: () => ({ list: services.list }), getPiecePackageWithoutArchive: vi.fn() }))

const user = { id: 'user-1', platformId: 'platform-1', platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE }
const project = { id: 'project-1', platformId: user.platformId, ownerId: user.id, type: ProjectType.PERSONAL }
const app = Fastify({ logger: false })
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)
app.decorateRequest('principal')
app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof ActivepiecesError && error.error.code === ErrorCode.AUTHORIZATION ? 403 : 500).send({ error: error instanceof Error ? error.message : 'Request failed' })
})
app.addHook('preHandler', authenticationMiddleware)
app.addHook('preHandler', authorizationMiddleware)
app.register(pieceModule)

beforeEach(() => {
    services.user.mockReset().mockResolvedValue(user)
    services.project.mockReset().mockResolvedValue(project)
    services.principal.mockReset().mockResolvedValue({ id: user.id, type: PrincipalType.USER, platform: { id: user.platformId } })
    services.list.mockReset().mockResolvedValue([{ name: '@activepieces/test', displayName: 'Test integration' }])
})
afterEach(() => { vi.clearAllMocks() })
afterAll(async () => { await app.close() })

describe('Community metadata HTTP project authorization', () => {
    it('returns metadata for the current owner', async () => {
        const response = await app.inject({ method: 'GET', url: '/v1/pieces?projectId=project-1', headers: { authorization: 'Bearer synthetic-token' } })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual([{ name: '@activepieces/test', displayName: 'Test integration' }])
        expect(services.list).toHaveBeenCalledOnce()
    })
    it('rejects foreign-project reads before accessing metadata', async () => {
        services.project.mockResolvedValue({ ...project, platformId: 'platform-2' })
        const response = await app.inject({ method: 'GET', url: '/v1/pieces?projectId=project-1', headers: { authorization: 'Bearer synthetic-token' } })
        expect(response.statusCode).toBe(403)
        expect(services.list).not.toHaveBeenCalled()
    })
    it('does not accept anonymous project-scoped metadata requests', async () => {
        const response = await app.inject({ method: 'GET', url: '/v1/pieces?projectId=project-1' })
        expect(response.statusCode).toBe(403)
        expect(services.list).not.toHaveBeenCalled()
    })
    it('retains the unscoped public catalog query', async () => {
        const response = await app.inject({ method: 'GET', url: '/v1/pieces' })
        expect(response.statusCode).toBe(200)
        expect(services.project).not.toHaveBeenCalled()
    })
})
