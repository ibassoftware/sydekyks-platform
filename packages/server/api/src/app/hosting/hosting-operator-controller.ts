import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { In, MoreThan } from 'typeorm'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { databaseConnection } from '../database/database-connection'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { HostingAccountEntity } from './hosting-entities'
import { ClientProfileInput, createHostedClientAdmin, hostedAccountKind } from './hosting-client-admin'
import { subscriptionAccountUntil } from './hosting-subscription-policy'
import { HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'
import { readHostedCredits } from './hosting-usage'

function operatorIds(): string[] {
    const raw = system.get(AppSystemProp.HOSTED_OPERATOR_IDENTITY_IDS)
    if (!raw?.trim()) return []
    const parsed = z.array(z.string().length(21)).max(100).safeParse(raw.split(',').map(value => value.trim()))
    return parsed.success ? parsed.data : []
}
export const hostingOperatorController: FastifyPluginAsyncZod = async app => {
    const config = { security: securityAccess.unscoped([PrincipalType.USER]) }
    const read = async <T>(request: FastifyRequest, requireOperator: boolean, fn: (manager: import('typeorm').EntityManager, allowed: boolean) => Promise<T>) => {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
        const principal = request.principal
        return tx.run({ dataSource: databaseConnection(), fn: async manager => {
            const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
            if (!user) hostingFail('HOSTING_ACCESS_DENIED')
            const actor = { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null }
            await tx.member({ manager, actor })
            const allowed = operatorIds().includes(actor.identityId) && user.platformRole === 'ADMIN'
            if (requireOperator && !allowed) hostingFail('HOSTING_OPERATOR_REQUIRED')
            return fn(manager, allowed)
        } })
    }
    app.get('/access', { config }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return read(request, false, async (_manager, allowed) => ({ allowed, platformId: request.principal.type === PrincipalType.USER ? request.principal.platform.id : '', userId: request.principal.id }))
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(error.message === 'HOSTING_CLIENT_REVISION_CONFLICT' ? 409 : 403).send({ code: error.message })
        throw error
    })
    const clientAdmin = createHostedClientAdmin({ dataSource: databaseConnection() })
    const actorOf = async (request: FastifyRequest) => {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
        const principal = request.principal
        const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
        if (!user) hostingFail('HOSTING_ACCESS_DENIED')
        return { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null }
    }
    app.get('/clients/:platformId', { config, schema: { params: z.strictObject({ platformId: z.string().length(21) }) } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return clientAdmin.read({ actor: await actorOf(request), platformId: request.params.platformId })
    })
    app.post('/clients/:platformId/profile', { config, bodyLimit: 4096, schema: { params: z.strictObject({ platformId: z.string().length(21) }), body: ClientProfileInput } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return clientAdmin.rename({ actor: await actorOf(request), platformId: request.params.platformId, input: request.body })
    })
    app.get('/clients', { config, schema: { querystring: z.object({ after: z.string().length(21).optional(), kind: z.enum(['all', 'client', 'partner', 'trial']).default('all') }).strict() } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return read(request, true, async manager => {
            const planFilter = request.query.kind === 'client' ? ['starter', 'team', 'scale'] as const : request.query.kind === 'partner' ? ['training', 'assessment'] as const : request.query.kind === 'trial' ? ['trial'] as const : null
            const rows = await manager.getRepository(HostingAccountEntity).find({ where: { ...(request.query.after ? { id: MoreThan(request.query.after) } : {}), ...(planFilter ? { planId: In([...planFilter]) } : {}) }, order: { id: 'ASC' }, take: 26 })
            const clients = []
            for (const row of rows.slice(0, 25)) {
                const account = await tx.account({ manager, platformId: row.id })
                const now = await tx.now(manager)
                const platform = await manager.getRepository(PlatformEntity).findOneByOrFail({ id: account.id })
                const [calls] = await manager.query('SELECT COUNT(*)::text AS calls, COUNT(*) FILTER (WHERE state = \'uncertain\')::text AS uncertain, COALESCE(SUM((usage->>\'total_tokens\')::numeric) FILTER (WHERE state = \'settled\'),0)::text AS "verifiedTokens" FROM hosting_model_call WHERE "platformId"=$1', [account.id])
                clients.push({ platformId: account.id, name: platform.name, accountKind: hostedAccountKind(account.planId), planId: account.planId, status: account.status, validUntil: subscriptionAccountUntil(account).toISOString(), activeExecutions: account.activeExecutions, credits: await readHostedCredits(manager, account, now), modelCalls: calls })
            }
            return { platformId: request.principal.type === PrincipalType.USER ? request.principal.platform.id : '', userId: request.principal.id, clients, next: rows.length > 25 ? rows[24].id : null }
        })
    })
}
