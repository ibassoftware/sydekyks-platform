import { HostedSubscriptionUpdate, PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { createHostedSubscriptions } from './hosting-subscriptions'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingSubscriptionController: FastifyPluginAsyncZod = async app => {
    const dataSource = databaseConnection(), subscriptions = createHostedSubscriptions({ dataSource })
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    const actorOf = async (request: FastifyRequest): Promise<HostingActor> => {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_OPERATOR_REQUIRED')
        const principal = request.principal
        return tx.run({ dataSource, fn: async manager => {
            const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
            if (!user) hostingFail('HOSTING_OPERATOR_REQUIRED')
            const actor = { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null }
            await assertHostingOperator({ manager, actor })
            return actor
        } })
    }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(/REVISION_CONFLICT|IDEMPOTENCY_CONFLICT/.test(error.message) ? 409 : 403).send({ code: error.message })
        throw error
    })
    app.get('/', { config, schema: { querystring: z.strictObject({ platformId: z.string().length(21) }) } }, async request => subscriptions.read({ actor: await actorOf(request), platformId: request.query.platformId }))
    app.post('/', { config, bodyLimit: 4096, schema: { body: HostedSubscriptionUpdate } }, async request => subscriptions.update({ actor: await actorOf(request), input: request.body }))
}
