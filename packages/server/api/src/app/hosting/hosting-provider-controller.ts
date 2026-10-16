import { AIProviderName, apId } from '@activepieces/core-utils'
import { PrincipalType } from '@activepieces/shared'
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
import { HOSTED_DEEPSEEK_MODEL } from './hosting-ai-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingProviderController: FastifyPluginAsyncZod = async app => {
    const user = { security: securityAccess.unscoped([PrincipalType.USER]) }
    const projectUser = { security: securityAccess.project([PrincipalType.USER], undefined, { type: ProjectResourceType.QUERY }) }
    const admin = { security: securityAccess.platformAdminOnly([PrincipalType.USER]) }
    const idParams = z.object({ id: z.string().length(21) })
    const common = { displayName: z.string().trim().min(1).max(80), config: z.strictObject({}).optional() }
    app.get('/configs', { config: admin }, async request => run(request, async manager => (await manager.getRepository(AIProviderEntity).findBy({ platformId: request.principal.platform.id, provider: AIProviderName.DEEPSEEK })).map(hostedKeyResponse)))
    app.get('/tiers', { config: user }, async request => run(request, async () => ({ flow: { tiers: [{ id: HOSTED_DEEPSEEK_MODEL, label: 'DeepSeek Flash', modelId: HOSTED_DEEPSEEK_MODEL }], defaultTierId: HOSTED_DEEPSEEK_MODEL }, chat: { tiers: [], defaultTierId: '' } }), false))
    app.get('/', { config: projectUser, schema: { querystring: z.object({ projectId: z.string().optional() }) } }, async request => run(request, async (manager, actor) => {
        await tx.member({ manager, actor, projectId: request.projectId })
        const rows = await manager.getRepository(AIProviderEntity).findBy({ platformId: actor.platformId, provider: AIProviderName.DEEPSEEK, status: 'active' })
        return [{ provider: AIProviderName.ACTIVEPIECES, name: 'Managed DeepSeek', enabledForChat: false, keys: [] }, { provider: AIProviderName.DEEPSEEK, name: 'DeepSeek', enabledForChat: false, keys: rows.filter(row => aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId: request.projectId } }) && aiKeyScope.keyOffersModel({ key: row, modelId: HOSTED_DEEPSEEK_MODEL })).map(row => ({ id: row.id, name: row.displayName })) }]
    }, false))
    app.get('/configs/:id/models', { config: admin, schema: { params: idParams } }, async request => run(request, async (_manager, actor) => hostedKeyModels({ platformId: actor.platformId, configId: request.params.id })))
    app.get('/:provider/models', { config: projectUser, schema: { params: z.object({ provider: z.enum([AIProviderName.DEEPSEEK, AIProviderName.ACTIVEPIECES]) }), querystring: z.object({ projectId: z.string().optional(), configId: z.string().optional() }) } }, async request => run(request, async (manager, actor) => {
        await tx.member({ manager, actor, projectId: request.projectId })
        if (request.params.provider === AIProviderName.DEEPSEEK && !request.query.configId) hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
        if (request.params.provider === AIProviderName.ACTIVEPIECES && request.query.configId) hostingFail('HOSTING_AI_PAYER_CONFLICT')
        if (request.query.configId) {
            const row = await manager.getRepository(AIProviderEntity).findOneBy({ id: request.query.configId, platformId: actor.platformId, provider: AIProviderName.DEEPSEEK, status: 'active' })
            if (!row || !aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId: request.projectId } }) || !aiKeyScope.keyOffersModel({ key: row, modelId: HOSTED_DEEPSEEK_MODEL })) hostingFail('HOSTING_BYOK_SCOPE_DENIED')
        }
        return hostedKeyModels({ platformId: actor.platformId })
    }, false))
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

async function run<T>(request: FastifyRequest, fn: (manager: import('typeorm').EntityManager, actor: HostingActor) => Promise<T>, admin = true): Promise<T> {
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
