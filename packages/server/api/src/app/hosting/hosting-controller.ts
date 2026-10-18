import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { EmailType, PasswordType, PlatformRole, PrincipalType, RequestEmailCodeRequest } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { authenticationUtils } from '../authentication/authentication-utils'
import { authenticationService } from '../authentication/authentication.service'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit, emailCodeRateLimit } from '../core/security/rate-limit'
import { networkUtils } from '../helper/network-utils'
import { userService } from '../user/user-service'
import { resendHostedVerification } from './hosting-auth-policy'
import { hostingConfiguration } from './hosting-configuration'
import { hostingAccessController } from './hosting-access-controller'
import { hostingOnboardingController } from './hosting-onboarding-controller'
import { hostingOperatorController } from './hosting-operator-controller'
import { hostingServices } from './hosting-services'
import { hostingStripeController } from './hosting-stripe-controller'
import { HostingActor, HostingError } from './hosting-transactions'

export const hostingController: FastifyPluginAsyncZod = async app => {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    await app.register(hostingAccessController, { prefix: '/operator' })
    await app.register(hostingOperatorController, { prefix: '/operator' })
    await app.register(hostingOnboardingController, { prefix: '/onboarding' })
    await app.register(hostingStripeController, { prefix: '/billing' })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(403).send({ code: error.message })
        throw error
    })
    app.post('/verification-code', { config: { security: securityAccess.public(), rateLimit: emailCodeRateLimit }, schema: { body: RequestEmailCodeRequest.strict() } }, async (request, reply) => {
        await resendHostedVerification({ ...request.body, remoteIp: networkUtils.clientIp(request), log: request.log })
        return reply.code(204).send()
    })
    app.post('/verify-email', { config: { security: securityAccess.public(), rateLimit: authnRateLimit }, schema: { body: z.strictObject({ email: EmailType, code: z.string().min(1).max(128), newPassword: PasswordType }) } }, async request => (await authenticationService(request.log).verifyHostedEmail(request.body)).response)
    const user = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    app.get('/balance', { config: user }, async request => {
        const grants = await hostingServices.ledger().balance({ actor: await actor(request) })
        return grants.map(grant => ({ meter: grant.meter, unit: grant.unit, amount: grant.amount.toString(), reserved: grant.reserved.toString(), consumed: grant.consumed.toString(), available: grant.available.toString(), microcreditsPerUnit: grant.microcreditsPerUnit?.toString() ?? null, validUntil: grant.validUntil.toISOString() }))
    })
    app.post('/invitations', { config: user, schema: { body: z.strictObject({ email: z.email(), role: z.enum(PlatformRole) }) } }, async request => {
        return (await hostingServices.onboarding()).invite({ actor: await actor(request), ...request.body })
    })
    app.delete('/invitations/:id', { config: user, schema: { params: z.object({ id: z.string() }) } }, async request => {
        await (await hostingServices.onboarding()).revokeInvitation({ actor: await actor(request), invitationId: request.params.id })
        return { success: true }
    })
    app.patch('/members/:id', { config: user, schema: { params: z.object({ id: z.string() }), body: z.strictObject({ role: z.enum(PlatformRole).optional(), deactivate: z.boolean().optional() }).refine(value => value.role !== undefined || value.deactivate === true) } }, async request => {
        await (await hostingServices.onboarding()).changeMember({ actor: await actor(request), userId: request.params.id, ...request.body })
        return { success: true }
    })
    app.post('/invitations/accept', { config: { security: securityAccess.unscoped([PrincipalType.USER, PrincipalType.ONBOARDING]), rateLimit: authnRateLimit }, schema: { body: z.strictObject({ token: z.string().length(43) }) } }, async request => {
        const identityId = request.principal.type === PrincipalType.ONBOARDING ? request.principal.id : (await userService(request.log).getOneOrFail({ id: request.principal.id })).identityId
        const tenant = await (await hostingServices.onboarding()).acceptInvitation({ identityId, token: request.body.token, expectedTokenVersion: request.principal.tokenVersion ?? null })
        return authenticationUtils(request.log).getProjectAndToken({ ...tenant, expectedTokenVersion: tenant.tokenVersion })
    })
}

async function actor(request: FastifyRequest): Promise<HostingActor> {
    if (request.principal.type !== PrincipalType.USER) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
    const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
    if (user.platformId !== request.principal.platform.id) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
    return { identityId: user.identityId, platformId: request.principal.platform.id, tokenVersion: request.principal.tokenVersion ?? null }
}
