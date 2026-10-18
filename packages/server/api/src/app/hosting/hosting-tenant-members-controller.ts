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
import { createHostedTenantMembers, TenantMemberChangeInput, TenantMemberInviteInput, TenantMemberRedeemInput, TenantMemberRevokeInput, TenantMemberSecret } from './hosting-tenant-members'
import { HostingActor, HostingError, hostingFail } from './hosting-transactions'

function assertRateLimited(): void {
    if (system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED) !== true) hostingFail('HOSTING_MEMBER_SETUP_UNAVAILABLE')
}
function limited(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429 
}
export const hostingTenantMembersController: FastifyPluginAsyncZod = async app => {
    const dataSource = databaseConnection(), service = createHostedTenantMembers({ dataSource, onboarding: await hostingServices.onboarding(), log: app.log })
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    async function actor(request: FastifyRequest): Promise<HostingActor> {
        assertRateLimited()
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_TENANT_ADMIN_REQUIRED')
        const user = await dataSource.getRepository(UserEntity).findOneBy({ id: request.principal.id, platformId: request.principal.platform.id })
        if (!user) hostingFail('HOSTING_TENANT_ADMIN_REQUIRED')
        return { identityId: user.identityId, platformId: request.principal.platform.id, tokenVersion: request.principal.tokenVersion ?? null }
    }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization').header('Referrer-Policy', 'no-referrer') 
    })
    app.setErrorHandler((error, _request, reply) => reply.code(limited(error) ? 429 : error instanceof HostingError ? /CONFLICT/.test(error.message) ? 409 : 403 : 400).send({ code: error instanceof HostingError ? error.message : 'HOSTING_MEMBERS_REQUEST_INVALID' }))
    app.get('/', { config }, async request => service.list({ actor: await actor(request) }))
    app.post('/invite', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: TenantMemberInviteInput } }, async request => service.command({ actor: await actor(request), input: request.body, action: 'invite' }))
    app.post('/change', { config, schema: { body: TenantMemberChangeInput } }, async request => service.command({ actor: await actor(request), input: request.body, action: 'change' }))
    app.post('/revoke', { config, schema: { body: TenantMemberRevokeInput } }, async request => service.command({ actor: await actor(request), input: request.body, action: 'revoke' }))
}
export const hostingTenantJoinController: FastifyPluginAsyncZod = async app => {
    const service = createHostedTenantMembers({ dataSource: databaseConnection(), onboarding: await hostingServices.onboarding(), log: app.log })
    const config = { security: securityAccess.public(), rateLimit: authnRateLimit }
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer') 
    })
    app.setErrorHandler((error, _request, reply) => reply.code(limited(error) ? 429 : 403).send({ code: limited(error) ? 'HOSTING_MEMBER_RATE_LIMITED' : 'HOSTING_MEMBER_LINK_UNAVAILABLE' }))
    app.post('/inspect', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: z.strictObject({ token: TenantMemberSecret }) } }, async request => {
        assertRateLimited(); return service.inspect(request.body.token) 
    })
    app.post('/redeem', { config, logLevel: 'silent', bodyLimit: 4096, schema: { body: TenantMemberRedeemInput } }, async request => {
        assertRateLimited()
        const tenant = await service.redeem(request.body)
        return authenticationUtils(request.log).getProjectAndToken({ ...tenant, expectedTokenVersion: tenant.tokenVersion })
    })
}
