import { HostedOnboardingOffer, HostedOnboardingStatus, hostingCatalog, PlatformRole, PrincipalType, RequestEmailCodeRequest } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { passwordlessAuthService } from '../authentication/passwordless-auth.service'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit, emailCodeRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { networkUtils } from '../helper/network-utils'
import { PlatformEntity } from '../platform/platform.entity'
import { userService } from '../user/user-service'
import { assertHostedEmailCodes, hostedEmailCodesAvailable, resendHostedVerification } from './hosting-auth-policy'
import { hostingConfiguration } from './hosting-configuration'
import { HostingStripeBindingEntity } from './hosting-stripe-entities'
import { hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingOnboardingController: FastifyPluginAsyncZod = async app => {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    })
    app.get('/', { config: { security: securityAccess.public() } }, async () => HostedOnboardingOffer.parse({ catalogVersion: hostingCatalog.version, emailCodesAvailable: hostedEmailCodesAvailable(app.log), trialDays: hostingCatalog.trialDays, trial: hostingCatalog.getPlan({ planId: 'trial' }) }))
    app.post('/email-code', { config: { security: securityAccess.public(), rateLimit: emailCodeRateLimit }, schema: { body: RequestEmailCodeRequest.strict() } }, async (request, reply) => {
        assertHostedEmailCodes(request.log)
        await passwordlessAuthService(request.log).requestCode({ ...request.body, captchaToken: request.body.captchaToken, platformId: null, remoteIp: networkUtils.clientIp(request), strictCaptcha: true })
        return reply.code(204).send()
    })
    app.post('/verification-code', { config: { security: securityAccess.public(), rateLimit: emailCodeRateLimit }, schema: { body: RequestEmailCodeRequest.strict() } }, async (request, reply) => {
        await resendHostedVerification({ ...request.body, remoteIp: networkUtils.clientIp(request), log: request.log })
        return reply.code(204).send()
    })
    app.post('/email-code/verify', { config: { security: securityAccess.public(), rateLimit: authnRateLimit }, schema: { body: z.strictObject({ email: z.email().trim().toLowerCase(), code: z.string().regex(/^\d{6}$/) }) } }, async request => {
        assertHostedEmailCodes(request.log)
        return (await passwordlessAuthService(request.log).verifyCode({ ...request.body, platformId: null })).response
    })
    app.get('/status', { config: { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit } }, async request => {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
        const principal = request.principal
        const member = await userService(request.log).getOneOrFail({ id: principal.id })
        return tx.run({ dataSource: databaseConnection(), fn: async manager => {
            const account = await tx.account({ manager, platformId: principal.platform.id })
            const user = await tx.member({ manager, actor: { identityId: member.identityId, platformId: account.id, tokenVersion: principal.tokenVersion ?? null } })
            if (user.id !== principal.id) hostingFail('HOSTING_ACCESS_DENIED')
            const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: user.identityId })
            const platform = await manager.getRepository(PlatformEntity).findOneByOrFail({ id: account.id })
            const bound = await manager.getRepository(HostingStripeBindingEntity).findOneBy({ platformId: account.id })
            const now = await tx.now(manager)
            const ended = account.validUntil <= now && bound?.holds.length === 1 && bound.holds[0] === 'subscription_ended'
            const paused = account.status === 'suspended' || (account.billingHold && !ended)
            return HostedOnboardingStatus.parse({ platformId: account.id, userId: user.id, platformName: platform.name, firstName: identity.firstName, isAdmin: user.platformRole === PlatformRole.ADMIN, planId: account.planId, entitlementState: paused ? 'paused' : account.validUntil <= now ? 'expired' : account.planId === 'trial' ? 'trial' : account.planId === 'training' ? 'training' : account.planId === 'assessment' ? 'assessment' : 'paid', validUntil: account.validUntil.toISOString(), serverTime: now.toISOString() })
        } })
    })
}
