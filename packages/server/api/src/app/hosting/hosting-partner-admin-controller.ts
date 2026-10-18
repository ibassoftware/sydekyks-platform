import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { createHostedPartnerAdmin, PartnerAssignmentInput, PartnerDecisionInput } from './hosting-partner-admin'
import { hostingServices } from './hosting-services'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingPartnerAdminController: FastifyPluginAsyncZod = async app => {
    const dataSource = databaseConnection()
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    const params = z.strictObject({ identityId: z.string().length(21) })
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
    const service = () => createHostedPartnerAdmin({ dataSource, onboarding: { provision: async input => (await hostingServices.onboarding()).provision(input) } })
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization') 
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(/REVISION_CONFLICT|IDEMPOTENCY_CONFLICT/.test(error.message) ? 409 : 403).send({ code: error.message })
        throw error
    })
    app.get('/lookup', { config, schema: { querystring: z.strictObject({ email: z.email().max(254) }) } }, async request => service().lookup({ actor: await actorOf(request), email: request.query.email }))
    app.get('/', { config, schema: { querystring: z.strictObject({ after: z.string().length(21).optional() }) } }, async request => service().list({ actor: await actorOf(request), after: request.query.after }))
    app.post('/:identityId/decision', { config, bodyLimit: 4096, schema: { params, body: PartnerDecisionInput } }, async request => service().mutate({ actor: await actorOf(request), identityId: request.params.identityId, input: request.body }))
    app.post('/:identityId/assignments', { config, bodyLimit: 4096, schema: { params, body: PartnerAssignmentInput } }, async request => service().mutate({ actor: await actorOf(request), identityId: request.params.identityId, input: request.body }))
}
