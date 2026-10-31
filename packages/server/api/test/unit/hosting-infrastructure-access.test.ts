import { PlatformRole, PrincipalType, UserStatus } from '@activepieces/shared'
import Fastify from 'fastify'
import { validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { healthModule } from '../../src/app/health/health.module'
import { requireHostedInfrastructureOperator } from '../../src/app/hosting/hosting-infrastructure-access'
import { UserEntity } from '../../src/app/user/user-entity'
import { workerMachineController } from '../../src/app/workers/machine/machine-controller'

const mocks = vi.hoisted(() => ({ repository: vi.fn(), protectedRead: vi.fn(), scopedRead: vi.fn() }))
vi.mock('../../src/app/database/database-connection', () => ({ databaseConnection: () => ({ getRepository: mocks.repository, manager: { getRepository: mocks.repository } }) }))
vi.mock('../../src/app/health/health.service', () => ({ healthStatusService: () => ({ isHealthy: () => true, getSystemHealthChecks: mocks.protectedRead, getDiagnostics: mocks.protectedRead }) }))
vi.mock('../../src/app/health/health-metrics.service', () => ({ healthMetricsService: () => ({ getRunMetrics: mocks.scopedRead, getQueueMetrics: mocks.scopedRead, getHealthHistory: mocks.scopedRead }) }))
vi.mock('../../src/app/workers/machine/machine-service', () => ({ machineService: () => ({ list: mocks.protectedRead }) }))
vi.mock('../../src/app/core/websockets.service', () => ({ websocketService: { addListener: vi.fn() } }))
vi.mock('../../src/app/workers/rpc/worker-rpc-service', () => ({ createHandlers: vi.fn() }))
vi.mock('../../src/app/workers/job-queue/job-broker', () => ({ jobBroker: vi.fn() }))
vi.mock('../../src/app/workers/job-queue/job-queue', () => ({ jobQueue: () => ({ getAllQueues: mocks.protectedRead }) }))

const operatorId = 'o'.repeat(21), tenantId = 'c'.repeat(21), platformId = 'p'.repeat(21)
let user: Record<string, unknown>, identity: Record<string, unknown>, principal: Record<string, unknown>
beforeEach(() => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    vi.stubEnv('AP_EDITION', 'ce')
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', operatorId)
    user = { id: 'u'.repeat(21), identityId: tenantId, platformId, platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE, externalId: null }
    identity = { id: tenantId, verified: true, tokenVersion: 'synthetic-current-session' }
    principal = { id: user.id, type: PrincipalType.USER, platform: { id: platformId }, tokenVersion: identity.tokenVersion }
    mocks.repository.mockReset().mockImplementation((entity: unknown) => ({ findOneBy: async (where: Record<string, unknown>) => {
        const row = entity === UserEntity ? user : entity === UserIdentityEntity ? identity : null
        return row && Object.entries(where).every(([key, value]) => row[key] === value) ? row : null
    } }))
    mocks.protectedRead.mockReset().mockReturnValue([])
    mocks.scopedRead.mockReset().mockResolvedValue({ running: 0, queued: 0, stuckJobs: [] })
})
afterEach(() => vi.unstubAllEnvs())
async function app() {
    const server = Fastify()
    server.setValidatorCompiler(validatorCompiler)
    server.setSerializerCompiler(() => data => JSON.stringify(data))
    server.addHook('preHandler', async request => { request.principal = principal as never })
    server.get('/protected', { preHandler: requireHostedInfrastructureOperator }, async () => ({ allowed: true }))
    await server.register(healthModule)
    await server.register(workerMachineController, { prefix: '/v1/worker-machines' })
    return server
}
const protectedUrls = ['/v1/worker-machines', '/v1/worker-machines/queue-metrics', '/v1/worker-machines/queue-metrics/prometheus', '/v1/health/system', '/v1/health/diagnostics']
describe('hosted shared infrastructure authorization', () => {
    it.each(['client owner', 'partner owner'])('rejects direct infrastructure APIs for a %s even with tenant ADMIN role', async () => {
        const server = await app()
        try {
            for (const url of protectedUrls) {
                const response = await server.inject(url)
                expect(response.statusCode, `${url}: ${response.body}`).toBe(403)
                expect(response.json()).toEqual({ code: 'HOSTING_OPERATOR_REQUIRED' })
                expect(response.headers['cache-control']).toBe('private, no-store')
            }
            expect(mocks.protectedRead).not.toHaveBeenCalled()
        }
        finally { await server.close() }
    })
    it('allows an allowlisted verified active platform administrator', async () => {
        user.identityId = operatorId; identity.id = operatorId
        const server = await app()
        try { expect((await server.inject('/protected')).statusCode).toBe(200) }
        finally { await server.close() }
    })
    it.each(['stale token', 'unverified', 'inactive', 'operational assignment', 'non-admin', 'service token'])('does not admit an allowlisted identity with %s', async reason => {
        user.identityId = operatorId; identity.id = operatorId
        if (reason === 'stale token') principal.tokenVersion = 'synthetic-stale-session'
        if (reason === 'unverified') identity.verified = false
        if (reason === 'inactive') user.status = UserStatus.INACTIVE
        if (reason === 'operational assignment') user.externalId = `sydekyks-operational:${operatorId}`
        if (reason === 'non-admin') user.platformRole = PlatformRole.MEMBER
        if (reason === 'service token') principal.type = PrincipalType.SERVICE
        const server = await app()
        try { expect((await server.inject('/protected')).statusCode).toBe(403) }
        finally { await server.close() }
    })
    it('leaves tenant run/queue/history queries scoped to the signed platform and public liveness available', async () => {
        const server = await app(), range = { createdAfter: '2026-10-01T00:00:00.000Z', createdBefore: '2026-10-31T23:59:59.999Z' }
        try {
            for (const route of ['run-metrics', 'queue-metrics']) {
                const response = await server.inject('/v1/health/' + route + '?' + new URLSearchParams(range))
                expect(response.statusCode, response.body).toBe(200)
                expect(mocks.scopedRead).toHaveBeenLastCalledWith(platformId, range)
            }
            expect((await server.inject('/v1/health/history')).statusCode).toBe(200)
            expect(mocks.scopedRead).toHaveBeenLastCalledWith(platformId)
            expect((await server.inject('/v1/health')).statusCode).toBe(200)
        }
        finally { await server.close() }
    })
    it('preserves self-hosted access under its existing platform-admin authentication', async () => {
        vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
        principal.type = PrincipalType.SERVICE
        const server = await app()
        try {
            expect((await server.inject('/protected')).statusCode).toBe(200)
            expect(mocks.repository).not.toHaveBeenCalled()
        }
        finally { await server.close() }
    })
})
