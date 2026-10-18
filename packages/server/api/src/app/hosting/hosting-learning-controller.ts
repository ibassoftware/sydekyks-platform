import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { createLearningFulfillment } from './hosting-learning-fulfillment'
import { HostingActor, hostingFail } from './hosting-transactions'

export const hostingLearningController: FastifyPluginAsyncZod = async app => {
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    const schema = { params: z.strictObject({ id: z.string().length(21) }), body: z.strictObject({}).optional() }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    })
    app.post('/training/enrollments/:id/activate', { config, schema }, async request => createLearningFulfillment({ dataSource: databaseConnection() }).activate({ actor: await actor(request), enrollmentId: request.params.id }))
    app.post('/training/enrollments/:id/revoke', { config, schema }, async request => {
        await createLearningFulfillment({ dataSource: databaseConnection() }).revoke({ actor: await actor(request), enrollmentId: request.params.id })
        return { revoked: true }
    })
}

async function actor(request: FastifyRequest): Promise<HostingActor> {
    if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
    const principal = request.principal
    const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
    if (!user) hostingFail('HOSTING_ACCESS_DENIED')
    return { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null }
}
