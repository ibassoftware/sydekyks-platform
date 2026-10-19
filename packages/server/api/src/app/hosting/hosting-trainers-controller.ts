import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { authenticationUtils } from '../authentication/authentication-utils'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { UserEntity } from '../user/user-entity'
import { hostingServices } from './hosting-services'
import { currentPlatformTrainer } from './hosting-trainer-policy'
import { createPlatformTrainers, TrainerAssign, TrainerDecision, TrainerOnboard, TrainerRedeem, TrainerSecret, TrainerSetupChange } from './hosting-trainers'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

function limited(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429 
}
function assertRateLimit(): void {
    if (system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED) !== true) hostingFail('HOSTING_TRAINER_UNAVAILABLE') 
}
async function actor(request: FastifyRequest): Promise<HostingActor> {
    assertRateLimit()
    if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_TRAINER_REQUIRED')
    const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id: request.principal.id, platformId: request.principal.platform.id })
    if (!user) hostingFail('HOSTING_TRAINER_REQUIRED')
    return { identityId: user.identityId, platformId: request.principal.platform.id, tokenVersion: request.principal.tokenVersion ?? null }
}
export const hostingTrainerAdminController: FastifyPluginAsyncZod = async app => {
    const service = createPlatformTrainers({ dataSource: databaseConnection(), onboarding: await hostingServices.onboarding(), log: app.log }), config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization') 
    })
    app.setErrorHandler((error, _request, reply) => reply.code(limited(error) ? 429 : error instanceof HostingError && /CONFLICT/.test(error.message) ? 409 : 403).send({ code: error instanceof HostingError ? error.message : 'HOSTING_TRAINER_REQUEST_INVALID' }))
    app.get('/', { config, schema: { querystring: z.strictObject({ email: z.email().max(254).optional() }) } }, async request => service.adminList({ actor: await actor(request), email: request.query.email }))
    app.post('/decision', { config, schema: { body: TrainerDecision } }, async request => service.adminCommand({ actor: await actor(request), input: request.body, action: 'role' }))
    app.post('/assignment', { config, schema: { body: TrainerAssign } }, async request => service.adminCommand({ actor: await actor(request), input: request.body, action: 'assignment' }))
}
export const hostingTrainerController: FastifyPluginAsyncZod = async app => {
    const dataSource = databaseConnection(), service = createPlatformTrainers({ dataSource, onboarding: await hostingServices.onboarding(), log: app.log }), config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization').header('Referrer-Policy', 'no-referrer') 
    })
    app.setErrorHandler((error, _request, reply) => reply.code(limited(error) ? 429 : error instanceof HostingError && /CONFLICT/.test(error.message) ? 409 : 403).send({ code: error instanceof HostingError ? error.message : 'HOSTING_TRAINER_REQUEST_INVALID' }))
    app.get('/access', { config }, async request => {
        const current = await actor(request)
        return tx.run({ dataSource, fn: async manager => ({ platformId: current.platformId, userId: request.principal.id, allowed: !!await currentPlatformTrainer({ manager, actor: current }) }) })
    })
    app.get('/portfolio', { config }, async request => service.portfolio({ actor: await actor(request) }))
    app.get('/learners', { config, schema: { querystring: z.strictObject({ audience: z.enum(['partner', 'end_user']).optional(), platformId: z.string().length(21).optional() }) } }, async request => service.learners({ actor: await actor(request), ...request.query }))
    app.post('/onboard', { config, logLevel: 'silent', schema: { body: TrainerOnboard } }, async request => service.onboard({ actor: await actor(request), input: request.body }))
    app.post('/setup/replace', { config, logLevel: 'silent', schema: { body: TrainerSetupChange } }, async request => service.setupChange({ actor: await actor(request), input: request.body }))
    app.post('/setup/revoke', { config, schema: { body: TrainerSetupChange } }, async request => service.setupChange({ actor: await actor(request), input: request.body, revoke: true }))
    app.post('/clients/:id/enter', { config, schema: { params: z.strictObject({ id: z.string().length(21) }) } }, async request => {
        const tenant = await service.enterClient({ actor: await actor(request), platformId: request.params.id })
        return authenticationUtils(request.log).getProjectAndToken({ ...tenant, expectedTokenVersion: tenant.tokenVersion })
    })
}
export const hostingTrainerSetupController: FastifyPluginAsyncZod = async app => {
    const service = createPlatformTrainers({ dataSource: databaseConnection(), onboarding: await hostingServices.onboarding(), log: app.log }), config = { security: securityAccess.public(), rateLimit: authnRateLimit }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer') 
    })
    app.setErrorHandler((error, _request, reply) => reply.code(limited(error) ? 429 : 403).send({ code: 'HOSTING_TRAINER_SETUP_UNAVAILABLE' }))
    app.post('/inspect', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: z.strictObject({ token: TrainerSecret }) } }, async request => {
        assertRateLimit(); return service.inspect(request.body.token) 
    })
    app.post('/redeem', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: TrainerRedeem } }, async request => {
        assertRateLimit(); const tenant = await service.redeem(request.body)
        return authenticationUtils(request.log).getProjectAndToken({ ...tenant, expectedTokenVersion: tenant.tokenVersion })
    })
}
