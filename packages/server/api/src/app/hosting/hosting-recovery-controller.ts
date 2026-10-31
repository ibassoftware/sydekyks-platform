import { PasswordType, PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { createHostedRecovery, RecoveryCommand, RecoveryRedeem, RecoverySecret } from './hosting-account-recovery'
import { setHostedUserPassword } from './hosting-password'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

function assertRateLimited(): void {
    if (system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED) !== true) hostingFail('HOSTING_RECOVERY_UNAVAILABLE')
}
function rateLimited(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429
}
export const hostingRecoveryController: FastifyPluginAsyncZod = async app => {
    const dataSource = databaseConnection(), service = createHostedRecovery({ dataSource })
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    const actorOf = async (request: FastifyRequest): Promise<HostingActor> => {
        assertRateLimited()
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
        void reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('Vary', 'Authorization') 
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(/CONFLICT/.test(error.message) ? 409 : 403).send({ code: error.message })
        return reply.code(rateLimited(error) ? 429 : 400).send({ code: 'HOSTING_RECOVERY_REQUEST_INVALID' })
    })
    app.post('/set-password', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: z.strictObject({ email: z.email().max(254), currentPassword: z.string().min(1).max(64), newPassword: PasswordType, reason: z.string().trim().min(10).max(1000) }) } }, async (request, reply) => {
        await setHostedUserPassword({ dataSource, actor: await actorOf(request), input: request.body })
        return reply.code(204).send()
    })
    app.get('/', { config, schema: { querystring: z.strictObject({ email: z.email().max(254) }) } }, async request => service.status({ actor: await actorOf(request), email: request.query.email }))
    // The one-time link is deliberately returned only by this explicit mutation,
    // never by the partner directory or the status endpoint.
    app.post('/issue', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: RecoveryCommand } }, async request => service.command({ actor: await actorOf(request), input: request.body, action: 'issue' }))
    app.post('/revoke', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: RecoveryCommand } }, async request => service.command({ actor: await actorOf(request), input: request.body, action: 'revoke' }))
}
export const hostingRecoveryPublicController: FastifyPluginAsyncZod = async app => {
    const service = createHostedRecovery({ dataSource: databaseConnection() })
    const config = { security: securityAccess.public(), rateLimit: authnRateLimit }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer') 
    })
    app.setErrorHandler((error, _request, reply) => reply.code(rateLimited(error) ? 429 : error instanceof HostingError ? 403 : 400).send({ code: rateLimited(error) ? 'HOSTING_RECOVERY_RATE_LIMITED' : 'HOSTING_RECOVERY_LINK_UNAVAILABLE' }))
    app.post('/inspect', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: z.strictObject({ token: RecoverySecret }) } }, async request => {
        assertRateLimited(); return service.inspect(request.body.token) 
    })
    app.post('/redeem', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: RecoveryRedeem } }, async request => {
        assertRateLimited(); return service.redeem(request.body) 
    })
}
