import { AIProviderName, apId } from '@activepieces/core-utils'
import { EngineResponseStatus, JobData, LATEST_JOB_DATA_SCHEMA_VERSION, PackageType, PieceType, Principal, PrincipalType, WorkerJobType } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { createHostedExecution } from '../../src/app/hosting/hosting-execution'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { hostingProviderController } from '../../src/app/hosting/hosting-provider-controller'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, app: FastifyInstance, previousConnection: unknown, principal: Principal
let value: { platformId: string, projectId: string, userId: string, identityId: string, tokenVersion: string | null, admissionId: string }
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    app = fastify()
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
    app.setErrorHandler((error, _request, reply) => reply.status(403).send({ message: error.message }))
    app.addHook('preHandler', async request => {
        request.principal = principal
    })
    app.addHook('preHandler', authorizationMiddleware)
    await app.register(hostingProviderController, { prefix: '/ai-providers' })
    await app.ready()
})
afterAll(async () => {
    if (app) await app.close()
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds?.isInitialized) await ds.destroy()
    vi.unstubAllEnvs()
})
beforeEach(async () => {
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@example.com`.toLowerCase(), provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Owner' })
    const tenant = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-property-metadata-secret-at-least-32-characters' }), identityId)
    if (!tenant.projectId) throw new Error('Expected tenant project')
    const id = apId(), data = JobData.parse({ schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_PROPERTY, platformId: tenant.platformId, projectId: tenant.projectId, requestId: id, webserverId: 'synthetic-property-metadata', actionOrTriggerName: 'askAi', propertyName: 'provider', input: {}, sampleData: {}, piece: { pieceName: '@activepieces/piece-ai', pieceVersion: '0.11.0', pieceType: PieceType.OFFICIAL, packageType: PackageType.REGISTRY } })
    const delivery = { queueName: 'property-provider-metadata-tests', jobId: id, data }, execution = createHostedExecution({ dataSource: ds }), queueToken = apId()
    await execution.prepare({ ...delivery, origin: { type: 'user', userId: tenant.userId, tokenVersion: tenant.tokenVersion } })
    const admissionId = await execution.admit({ ...delivery, queueToken })
    expect(await execution.start({ ...delivery, queueToken, admissionId, connectionId: apId() })).toBe(true)
    value = { ...tenant, projectId: tenant.projectId, identityId, admissionId }
    principal = { type: PrincipalType.ENGINE, id: admissionId, platform: { id: tenant.platformId }, projectId: tenant.projectId }
})

describe('hosted provider metadata for live PROPERTY admissions', () => {
    it('returns only filtered key names and virtual model metadata on the three read-only routes', async () => {
        const keyId = apId(), otherKeyId = apId()
        for (const [id, projectIds] of [[keyId, [value.projectId]], [otherKeyId, [apId()]]] as const) await ds.getRepository(AIProviderEntity).save({ id, platformId: value.platformId, provider: AIProviderName.DEEPSEEK, displayName: id === keyId ? 'Client key' : 'Other workspace key', auth: { iv: 'synthetic-iv', data: 'never-expose-this-synthetic-key' }, config: {}, status: 'active', projectScope: 'selected', projectIds: [...projectIds], modelScope: 'all', modelIds: [], enabledForChat: false, statusVersion: 0 })
        const before = await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })
        const providers = await app.inject({ method: 'GET', url: '/ai-providers/' })
        expect(providers.statusCode).toBe(200)
        expect(providers.json()).toEqual([{ provider: 'activepieces', name: 'Sydekyks', enabledForChat: false, keys: [] }, { provider: 'deepseek', name: 'DeepSeek', enabledForChat: false, keys: [{ id: keyId, name: 'Client key' }] }])
        const tiers = await app.inject({ method: 'GET', url: '/ai-providers/tiers' })
        expect(tiers.statusCode).toBe(200); expect(tiers.body).toContain('Sydekyks')
        const models = await app.inject({ method: 'GET', url: '/ai-providers/activepieces/models' })
        expect(models.statusCode).toBe(200); expect(models.json()).toEqual([{ id: 'sydekyks', name: 'Sydekyks', type: 'text' }])
        expect((await app.inject({ method: 'GET', url: `/ai-providers/deepseek/models?configId=${keyId}` })).statusCode).toBe(200)
        expect((await app.inject({ method: 'GET', url: `/ai-providers/deepseek/models?configId=${otherKeyId}` })).statusCode).toBe(403)
        expect(providers.body + tiers.body + models.body).not.toContain('never-expose')
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(before)
    })
    it.each(['/ai-providers/', '/ai-providers/tiers', '/ai-providers/activepieces/models'])('rejects a foreign query project on %s', async url => {
        const response = await app.inject({ method: 'GET', url: `${url}?projectId=${apId()}` })
        expect(response.statusCode).toBe(403); expect(response.body).toContain('HOSTING_PROJECT_ACCESS_DENIED')
    })
    it.each(['expired', 'completed', 'wrong-job', 'payload-project', 'payload-platform', 'principal-platform', 'principal-project'])('rejects %s property provenance', async change => {
        const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: value.admissionId })
        if (change === 'expired') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { leaseUntil: new Date(Date.now() - 1000) })
        if (change === 'completed') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { completionStatus: EngineResponseStatus.OK })
        if (change === 'wrong-job') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { payload: { ...dispatch.payload, jobType: WorkerJobType.EXECUTE_VALIDATION } as JobData })
        if (change === 'payload-project') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { payload: { ...dispatch.payload, projectId: apId() } as JobData })
        if (change === 'payload-platform') await ds.getRepository(HostingDispatchEntity).update({ id: dispatch.id }, { payload: { ...dispatch.payload, platformId: apId() } as JobData })
        if (change === 'principal-platform') principal = { ...principal, platform: { id: apId() } } as Principal
        if (change === 'principal-project') principal = { ...principal, projectId: apId() } as Principal
        expect((await app.inject({ method: 'GET', url: '/ai-providers/tiers' })).statusCode).toBe(403)
    })
    it('rechecks the recorded actor token after a user session is revoked', async () => {
        await ds.getRepository(UserIdentityEntity).update({ id: value.identityId }, { tokenVersion: apId() })
        const response = await app.inject({ method: 'GET', url: '/ai-providers/tiers' })
        expect(response.statusCode).toBe(403); expect(response.body).toContain('HOSTING_ACCESS_DENIED')
    })
    it.each(['/ai-providers/configs', `/ai-providers/configs/${'x'.repeat(21)}/models`, `/ai-providers/chat-options?projectId=${'x'.repeat(21)}`])('keeps ENGINE denied on privileged metadata route %s', async url => {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403)
    })
    it.each(['POST', 'DELETE'] as const)('keeps ENGINE denied on provider %s mutations', async method => {
        const response = await app.inject({ method, url: method === 'POST' ? '/ai-providers/' : `/ai-providers/${'x'.repeat(21)}`, ...(method === 'POST' ? { payload: { displayName: 'Forbidden mutation', provider: 'deepseek', auth: { apiKey: 'synthetic-forbidden' } } } : {}) })
        expect(response.statusCode).toBe(403)
        expect(await ds.getRepository(AIProviderEntity).countBy({ platformId: value.platformId })).toBe(0)
    })
    it('preserves ordinary authenticated user metadata access', async () => {
        principal = { type: PrincipalType.USER, id: value.userId, platform: { id: value.platformId }, tokenVersion: value.tokenVersion ?? undefined }
        expect((await app.inject({ method: 'GET', url: `/ai-providers/?projectId=${value.projectId}` })).statusCode).toBe(200)
        expect((await app.inject({ method: 'GET', url: '/ai-providers/tiers' })).statusCode).toBe(200)
    })
})
