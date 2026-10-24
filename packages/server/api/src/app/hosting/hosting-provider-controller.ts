import { AIProviderName, apId } from '@activepieces/core-utils'
import { PrincipalType, WorkerJobType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { In } from 'typeorm'
import { z } from 'zod'
import { aiKeyScope } from '../ai/ai-key-scope'
import { AIProviderEntity } from '../ai/ai-provider-entity'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { databaseConnection } from '../database/database-connection'
import { encryptUtils } from '../helper/encryption'
import { ProjectEntity } from '../project/project-entity'
import { UserEntity } from '../user/user-entity'
import { HostedKeyAuth, hostedKeyModels, hostedKeyResponse } from './hosting-ai-credentials'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL } from './hosting-ai-policy'
import { hostedChatOptions } from './hosting-chat-options'
import { HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingProviderController: FastifyPluginAsyncZod = async app => {
    const user = { security: securityAccess.unscoped([PrincipalType.USER]) }
    const propertyMetadata = { security: securityAccess.unscoped([PrincipalType.USER, PrincipalType.ENGINE]) }
    const projectMetadata = { security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE], undefined, { type: ProjectResourceType.QUERY }) }
    const admin = { security: securityAccess.platformAdminOnly([PrincipalType.USER]) }
    const idParams = z.object({ id: z.string().length(21) })
    const common = { displayName: z.string().trim().min(1).max(80), config: z.strictObject({}).optional() }
    app.get('/chat-options', { config: user, schema: { querystring: z.object({ projectId: z.string().length(21), conversationId: z.string().length(21).optional(), agentId: z.string().length(21).optional(), builder: z.enum(['true', 'false']).transform(value => value === 'true').optional() }).strict() } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return run(request, async (manager, actor) => hostedChatOptions({ manager, actor, userId: request.principal.id, ...request.query, log: request.log }), false)
    })
    app.get('/configs', { config: admin }, async request => run(request, async manager => (await manager.getRepository(AIProviderEntity).findBy({ platformId: request.principal.platform.id, provider: AIProviderName.DEEPSEEK })).map(hostedKeyResponse)))
    app.get('/tiers', { config: propertyMetadata }, async request => run(request, async () => ({ flow: { tiers: [{ id: HOSTED_MANAGED_MODEL, label: 'Sydekyks', modelId: HOSTED_MANAGED_MODEL }], defaultTierId: HOSTED_MANAGED_MODEL }, chat: { tiers: [], defaultTierId: '' } }), false, true))
    app.get('/', { config: projectMetadata, schema: { querystring: z.object({ projectId: z.string().optional() }) } }, async request => run(request, async (manager, actor) => {
        await tx.member({ manager, actor, projectId: request.principal.type === PrincipalType.ENGINE ? request.principal.projectId : request.projectId })
        const rows = await manager.getRepository(AIProviderEntity).findBy({ platformId: actor.platformId, provider: AIProviderName.DEEPSEEK, status: 'active' })
        const keys = rows.filter(row => aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId: request.principal.type === PrincipalType.ENGINE ? request.principal.projectId : request.projectId } }) && aiKeyScope.keyOffersModel({ key: row, modelId: HOSTED_DEEPSEEK_MODEL })).map(row => ({ id: row.id, name: row.displayName }))
        return [{ provider: AIProviderName.ACTIVEPIECES, name: 'Sydekyks', enabledForChat: false, keys: [] }, ...(keys.length ? [{ provider: AIProviderName.DEEPSEEK, name: 'DeepSeek', enabledForChat: false, keys }] : [])]
    }, false, true))
    app.get('/configs/:id/models', { config: admin, schema: { params: idParams } }, async request => run(request, async (_manager, actor) => hostedKeyModels({ platformId: actor.platformId, configId: request.params.id })))
    app.get('/:provider/models', { config: projectMetadata, schema: { params: z.object({ provider: z.enum([AIProviderName.DEEPSEEK, AIProviderName.ACTIVEPIECES]) }), querystring: z.object({ projectId: z.string().optional(), configId: z.string().optional() }) } }, async request => run(request, async (manager, actor) => {
        await tx.member({ manager, actor, projectId: request.principal.type === PrincipalType.ENGINE ? request.principal.projectId : request.projectId })
        if (request.params.provider === AIProviderName.DEEPSEEK && !request.query.configId) hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
        if (request.params.provider === AIProviderName.ACTIVEPIECES && request.query.configId) hostingFail('HOSTING_AI_PAYER_CONFLICT')
        if (request.query.configId) {
            const row = await manager.getRepository(AIProviderEntity).findOneBy({ id: request.query.configId, platformId: actor.platformId, provider: AIProviderName.DEEPSEEK, status: 'active' })
            if (!row || !aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId: request.principal.type === PrincipalType.ENGINE ? request.principal.projectId : request.projectId } }) || !aiKeyScope.keyOffersModel({ key: row, modelId: HOSTED_DEEPSEEK_MODEL })) hostingFail('HOSTING_BYOK_SCOPE_DENIED')
        }
        return request.params.provider === AIProviderName.ACTIVEPIECES ? [{ id: HOSTED_MANAGED_MODEL, name: 'Sydekyks', type: 'text' }] : hostedKeyModels({ platformId: actor.platformId })
    }, false, true))
    app.post('/', { config: admin, schema: { body: z.strictObject({ ...common, provider: z.literal(AIProviderName.DEEPSEEK), auth: HostedKeyAuth }) } }, async request => {
        const auth = await encryptUtils.encryptObject(request.body.auth)
        return run(request, async (manager, actor) => {
            const row = await manager.getRepository(AIProviderEntity).save({ id: apId(), platformId: actor.platformId, provider: AIProviderName.DEEPSEEK, displayName: request.body.displayName, auth, config: {}, status: 'active', modelScope: 'all', modelIds: [], projectScope: 'all', projectIds: [], enabledForChat: false, statusVersion: 0 })
            return hostedKeyResponse(row)
        })
    })
    app.post('/:id', { config: admin, schema: { params: idParams, body: z.strictObject({ ...common, auth: HostedKeyAuth.optional(), modelScope: z.enum(['all', 'selected']).optional(), modelIds: z.array(z.literal(HOSTED_DEEPSEEK_MODEL)).max(1).optional(), projectScope: z.enum(['all', 'selected', 'except']).optional(), projectIds: z.array(z.string()).max(100).optional(), enabledForChat: z.literal(false).optional() }) } }, async request => {
        const auth = request.body.auth ? await encryptUtils.encryptObject(request.body.auth) : undefined
        return run(request, async (manager, actor) => {
            const row = await manager.getRepository(AIProviderEntity).findOneBy({ id: request.params.id, platformId: actor.platformId, provider: AIProviderName.DEEPSEEK })
            if (!row) hostingFail('HOSTING_BYOK_SCOPE_DENIED')
            if (request.body.projectIds?.length) {
                const ids = [...new Set(request.body.projectIds)]
                if (await manager.getRepository(ProjectEntity).countBy({ id: In(ids), platformId: actor.platformId }) !== ids.length) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
            }
            await manager.getRepository(AIProviderEntity).save({ ...row, ...request.body, auth: auth ?? row.auth, config: {}, statusVersion: row.statusVersion + 1 })
            return { success: true }
        })
    })
    app.delete('/:id', { config: admin, schema: { params: idParams } }, async request => run(request, async (manager, actor) => {
        await manager.getRepository(AIProviderEntity).delete({ id: request.params.id, platformId: actor.platformId, provider: AIProviderName.DEEPSEEK })
        return { success: true }
    }))
}

async function run<T>(request: FastifyRequest, fn: (manager: import('typeorm').EntityManager, actor: HostingActor) => Promise<T>, admin = true, propertyMetadata = false): Promise<T> {
    if (request.principal.type === PrincipalType.ENGINE && propertyMetadata && !admin) {
        const principal = request.principal
        const requestedProject = (request.query as { projectId?: string } | undefined)?.projectId
        if (!principal.projectId || (requestedProject !== undefined && requestedProject !== principal.projectId)) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
        return tx.run({ dataSource: databaseConnection(), fn: async manager => {
            const account = await tx.account({ manager, platformId: principal.platform.id })
            const now = await tx.now(manager)
            const dispatch = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId: principal.id, platformId: principal.platform.id, projectId: principal.projectId, state: 'running' })
            if (!dispatch || dispatch.payload?.jobType !== WorkerJobType.EXECUTE_PROPERTY || dispatch.payload.projectId !== principal.projectId || dispatch.payload.platformId !== principal.platform.id || dispatch.completionStatus || dispatch.terminalReceipt || !dispatch.leaseUntil || dispatch.leaseUntil <= now) hostingFail('HOSTING_PROPERTY_METADATA_DENIED')
            const actor: HostingActor = { platformId: dispatch.platformId, identityId: dispatch.identityId, ...(dispatch.originType === 'user' ? { tokenVersion: dispatch.tokenVersion } : {}) }
            await tx.member({ manager, actor, projectId: principal.projectId, write: true })
            tx.assertActive({ account, now })
            return fn(manager, actor)
        } })
    }
    if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
    const principal = request.principal
    return tx.run({ dataSource: databaseConnection(), fn: async manager => {
        await tx.account({ manager, platformId: principal.platform.id })
        const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
        if (!user) hostingFail('HOSTING_ACCESS_DENIED')
        const actor = { platformId: principal.platform.id, identityId: user.identityId, tokenVersion: principal.tokenVersion ?? null }
        await tx.member({ manager, actor, admin })
        return fn(manager, actor)
    } })
}
