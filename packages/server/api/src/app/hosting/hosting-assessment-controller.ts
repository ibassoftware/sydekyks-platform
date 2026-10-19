import { PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { createHostedAssessment } from './hosting-assessment'
import { hostingFail } from './hosting-transactions'

export const hostingAssessmentController: FastifyPluginAsyncZod = async app => {
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    const schema = { params: z.strictObject({ id: z.string().length(21) }), body: z.strictObject({}).optional() }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization') 
    })
    for (const action of ['activate', 'revoke'] as const) app.post(`/enrollments/:id/${action}`, { config, schema }, async request => {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
        const principal = request.principal
        const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
        if (!user) hostingFail('HOSTING_ACCESS_DENIED')
        const result = await createHostedAssessment({ dataSource: databaseConnection() })[action]({ actor: { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion }, enrollmentId: request.params.id })
        return result ? { id: result.id, enrollmentId: result.enrollmentId, platformId: result.platformId, startsAt: result.startsAt.toISOString(), endsAt: result.endsAt.toISOString(), revoked: !!result.revokedAt } : { revoked: true }
    })
}
