import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { userService } from '../user/user-service'
import { hostingConfiguration } from './hosting-configuration'
import { hostingServices } from './hosting-services'
import { HostingActor, hostingFail } from './hosting-transactions'

export const hostingStripeController: FastifyPluginAsyncZod = async app => {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    const user = { security: securityAccess.platformAdminOnly([PrincipalType.USER]), rateLimit: authnRateLimit }
    app.get('/', { config: user }, async request => (await hostingServices.billing()).status(await actor(request)))
    app.post('/checkout', { config: user, schema: { body: z.strictObject({ planId: z.enum(['starter', 'team']) }) } }, async request => (await hostingServices.billing()).checkout(await actor(request), request.body.planId))
    app.post('/portal', { config: user, schema: { body: z.strictObject({}) } }, async request => (await hostingServices.billing()).portal(await actor(request)))
    app.post('/stripe-webhook', { bodyLimit: 262144, config: { security: securityAccess.public(), rawBody: true }, schema: { headers: z.object({ 'stripe-signature': z.string().min(1).max(4096) }) } }, async (request, reply) => {
        if (typeof request.rawBody !== 'string') hostingFail('HOSTING_STRIPE_RAW_BODY_REQUIRED')
        await (await hostingServices.billing()).ingest(request.rawBody, request.headers['stripe-signature'])
        return reply.code(204).send()
    })
}
async function actor(request: FastifyRequest): Promise<HostingActor> {
    if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
    const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
    if (user.platformId !== request.principal.platform.id) hostingFail('HOSTING_ACCESS_DENIED')
    return { platformId: request.principal.platform.id, identityId: user.identityId, tokenVersion: request.principal.tokenVersion ?? null }
}
