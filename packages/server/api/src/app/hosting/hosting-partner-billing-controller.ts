import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { userService } from '../user/user-service'
import { createHostedPartnerBilling } from './hosting-partner-billing'
import { HostingActor, HostingError, hostingFail } from './hosting-transactions'

export const hostingPartnerBillingController: FastifyPluginAsyncZod = async app => {
    const user = { security: securityAccess.platformAdminOnly([PrincipalType.USER]), rateLimit: authnRateLimit }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization').header('Referrer-Policy', 'no-referrer')
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(error.message.includes('CONFLICT') ? 409 : 403).send({ code: error.message })
        return reply.code(400).send({ code: 'HOSTING_PARTNER_REQUEST_UNAVAILABLE' })
    })
    app.get('/', { config: user }, async request => (await createHostedPartnerBilling({ dataSource: databaseConnection() })).status(await actor(request)))
    app.post('/checkout', { config: user, schema: { body: z.strictObject({ package: z.enum(['core', 'guided']) }) } }, async request => (await createHostedPartnerBilling({ dataSource: databaseConnection() })).checkout(await actor(request), request.body.package))
}
async function actor(request: FastifyRequest): Promise<HostingActor> {
    if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
    const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
    if (user.platformId !== request.principal.platform.id) hostingFail('HOSTING_ACCESS_DENIED')
    return { platformId: request.principal.platform.id, identityId: user.identityId, tokenVersion: request.principal.tokenVersion ?? null }
}
