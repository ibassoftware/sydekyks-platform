import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { encryptUtils } from '../helper/encryption'
import { UserEntity } from '../user/user-entity'
import { hostingConfiguration } from './hosting-configuration'
import { createHostedManualAccounts } from './hosting-manual-accounts'
import { HostingManualAccountCreate, HostingManualEnrollmentCreate, HostingManualTermCreate } from './hosting-manual-accounts-schema'
import { HostingActor, HostingError, hostingFail } from './hosting-transactions'

export const hostingManualAccountsController: FastifyPluginAsyncZod = async app => {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    async function service() {
        const subjectSecret = await encryptUtils.getEncryptionKey()
        if (!subjectSecret) hostingFail('HOSTING_SUBJECT_SECRET_REQUIRED')
        return createHostedManualAccounts({ dataSource: databaseConnection(), subjectSecret })
    }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('Vary', 'Authorization')
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(/CONFLICT|EMAIL_EXISTS|ACTIVE_TERM/.test(error.message) ? 409 : 403).send({ code: error.message })
        if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429) return reply.code(429).send({ code: 'HOSTING_MANUAL_RATE_LIMITED' })
        return reply.code(400).send({ code: 'HOSTING_MANUAL_REQUEST_INVALID' })
    })
    app.get('/', { config, schema: { querystring: z.strictObject({ platformId: z.string().length(21) }) } }, async request => (await service()).read({ actor: await actor(request), platformId: request.query.platformId }))
    // Password-bearing bodies are never logged or returned. Operator authority,
    // existing-identity collision and immutable command digest checks are server-side.
    app.post('/', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: HostingManualAccountCreate } }, async request => (await service()).create({ actor: await actor(request), input: request.body }))
    app.post('/:platformId/enrollment', { config, logLevel: 'silent', bodyLimit: 4096, schema: { params: z.strictObject({ platformId: z.string().length(21) }), body: HostingManualEnrollmentCreate } }, async request => (await service()).enroll({ actor: await actor(request), platformId: request.params.platformId, input: request.body }))
    app.post('/:platformId/terms', { config, logLevel: 'silent', bodyLimit: 4096, schema: { params: z.strictObject({ platformId: z.string().length(21) }), body: HostingManualTermCreate } }, async request => (await service()).renew({ actor: await actor(request), platformId: request.params.platformId, input: request.body }))
}
async function actor(request: FastifyRequest): Promise<HostingActor> {
    if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_OPERATOR_REQUIRED')
    const principal = request.principal
    const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
    if (!user) hostingFail('HOSTING_OPERATOR_REQUIRED')
    return { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null }
}
