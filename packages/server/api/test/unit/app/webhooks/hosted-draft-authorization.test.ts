import { ActivepiecesError, ErrorCode, Permission } from '@activepieces/core-utils'
import { PrincipalType } from '@activepieces/shared'
import fastify, { FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectTableResource } from '../../../../src/app/core/security/authorization/common'
import { authenticationMiddleware } from '../../../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../../../src/app/core/security/v2/authz/authorization-middleware'
import { webhookController } from '../../../../src/app/webhooks/webhook-controller'

const state = vi.hoisted(() => ({ mode: 'hosted', handle: vi.fn(), convert: vi.fn(), authorize: vi.fn(), capture: vi.fn() }))
vi.mock('../../../../src/app/hosting/hosting-configuration', () => ({ hostingConfiguration: { getServiceMode: () => state.mode } }))
vi.mock('../../../../src/app/webhooks/webhook.service', () => ({ WebhookFlowVersionToRun: { LATEST: 'latest', LOCKED_FALL_BACK_TO_LATEST: 'locked_fall_back_to_latest' }, webhookService: { handleWebhook: state.handle } }))
vi.mock('../../../../src/app/webhooks/webhook-request-converter', () => ({ convertRequest: state.convert, extractHeaderFromRequest: () => ({ failParentOnFailure: false }) }))
vi.mock('../../../../src/app/trigger/trigger-source/trigger-source-service', () => ({ triggerSourceService: () => ({ existsByFlowId: state.capture }) }))
vi.mock('../../../../src/app/authentication/lib/access-token-manager', () => ({ accessTokenManager: () => ({ verifyPrincipal: async (token: string) => {
    if (token === 'stale') throw new ActivepiecesError({ code: ErrorCode.AUTHENTICATION, params: { message: 'Expired token' } })
    return { type: PrincipalType.USER, id: token, tokenVersion: 'current-token-version', platform: { id: token === 'foreign-platform' ? 'plat-other' : 'plat-1' } }
} }) }))
vi.mock('../../../../src/app/core/security/v2/authz/projectIdExtractor', () => ({ projectIdExtractor: { fromTable: async (request: FastifyRequest, resource: ProjectTableResource) => {
    expect(resource.lookup).toEqual({ paramKey: 'flowId', entityField: 'id' })
    expect(resource.tableName.options.name).toBe('flow')
    return (request.params as { flowId: string }).flowId === 'foreignflow0000000000' ? 'proj-other' : 'proj-1'
} } }))
vi.mock('../../../../src/app/sydekyks-community/project-access', () => ({ communityAuthorization: { assertProjectAccess: state.authorize } }))

async function appFor(mode = 'hosted') {
    state.mode = mode
    const app = fastify()
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    app.setErrorHandler((error, _request, reply) => {
        void reply.status(error instanceof ActivepiecesError ? 403 : 500).send({ error: 'Denied' })
    })
    app.addHook('preHandler', authenticationMiddleware)
    app.addHook('preHandler', authorizationMiddleware)
    await app.register(webhookController, { prefix: '/api/v1/webhooks' })
    return app
}
beforeEach(() => {
    vi.clearAllMocks()
    state.capture.mockResolvedValue(true)
    state.handle.mockResolvedValue({ status: 200, body: {}, headers: {} })
    state.authorize.mockImplementation(async ({ principal, projectId, permission }) => {
        expect(permission).toBe(Permission.WRITE_RUN)
        if (principal.id === 'viewer' || projectId !== 'proj-1' || principal.platform.id !== 'plat-1') throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'No run permission' } })
    })
})
describe('hosted draft Form route authorization', () => {
    for (const suffix of ['/draft', '/draft/sync']) {
        it(`denies anonymous, wrong tenant, foreign project and missing run permission before ${suffix} dispatch`, async () => {
            const app = await appFor()
            try {
                for (const scenario of [{}, { token: 'stale' }, { token: 'viewer' }, { token: 'foreign-platform' }, { token: 'runner', flowId: 'foreignflow0000000000' }]) {
                    const response = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${scenario.flowId ?? 'ownflow00000000000000'}${suffix}`, ...(scenario.token ? { headers: { authorization: `Bearer ${scenario.token}` } } : {}), payload: { name: 'Test' } })
                    expect(response.statusCode, response.body).toBe(403)
                }
                expect(state.handle).not.toHaveBeenCalled()
                expect(state.convert).not.toHaveBeenCalled()
            }
            finally {
                await app.close()
            }
        })
        it(`passes the verified principal and extracted exact workspace to ${suffix}`, async () => {
            const app = await appFor()
            try {
                const response = await app.inject({ method: 'POST', url: `/api/v1/webhooks/ownflow00000000000000${suffix}`, headers: { authorization: 'Bearer runner' }, payload: { name: 'Test', hostedDraftActor: { userId: 'forged', platformId: 'foreign', projectId: 'foreign', tokenVersion: 'forged' } } })
                expect(response.statusCode, response.body).toBe(200)
                expect(state.authorize).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1', permission: Permission.WRITE_RUN }))
                expect(state.handle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostedDraftActor: { userId: 'runner', tokenVersion: 'current-token-version', projectId: 'proj-1', platformId: 'plat-1' }, flowId: 'ownflow00000000000000' }))
            }
            finally {
                await app.close()
            }
        })
    }
    for (const suffix of ['', '/sync']) it(`keeps hosted published ${suffix || 'async'} submissions executable while an editor is listening`, async () => {
        const app = await appFor()
        try {
            const response = await app.inject({ method: 'POST', url: `/api/v1/webhooks/ownflow00000000000000${suffix}`, payload: { name: 'Test' } })
            expect(response.statusCode).toBe(200)
            expect(state.authorize).not.toHaveBeenCalled()
            expect(state.handle.mock.calls[0][0]).toMatchObject({ execute: true, saveSampleData: false })
            expect(state.handle.mock.calls[0][0]).not.toHaveProperty('hostedDraftActor')
            expect(state.capture).not.toHaveBeenCalled()
        }
        finally {
            await app.close()
        }
    })
    it('preserves implicit listener capture on self-hosted published webhooks', async () => {
        const app = await appFor('self_hosted')
        try {
            expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/ownflow00000000000000', payload: {} })).statusCode).toBe(200)
            expect(state.capture).toHaveBeenCalledExactlyOnceWith({ flowId: 'ownflow00000000000000', simulate: true })
            expect(state.handle.mock.calls[0][0]).toMatchObject({ execute: true, saveSampleData: true })
        }
        finally {
            await app.close()
        }
    })
    it('keeps the explicit hosted test endpoint capture-only', async () => {
        const app = await appFor()
        try {
            expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/ownflow00000000000000/test', payload: {} })).statusCode).toBe(200)
            expect(state.handle.mock.calls[0][0]).toMatchObject({ execute: false, saveSampleData: true })
            expect(state.handle.mock.calls[0][0]).not.toHaveProperty('hostedDraftActor')
        }
        finally {
            await app.close()
        }
    })
    it('preserves public draft behavior for self-hosted installations', async () => {
        const app = await appFor('self_hosted')
        try {
            const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/ownflow00000000000000/draft', payload: { name: 'Test' } })
            expect(response.statusCode).toBe(200)
            expect(state.authorize).not.toHaveBeenCalled()
            expect(state.handle.mock.calls[0][0].hostedDraftActor).toBeUndefined()
        }
        finally {
            await app.close()
        }
    })
})
