import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { EmailType, PasswordType, PrincipalType, RequestEmailCodeRequest } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { authenticationService } from '../authentication/authentication.service'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit, emailCodeRateLimit } from '../core/security/rate-limit'
import { networkUtils } from '../helper/network-utils'
import { userService } from '../user/user-service'
import { hostingAccessController } from './hosting-access-controller'
import { hostingAssessmentController } from './hosting-assessment-controller'
import { resendHostedVerification } from './hosting-auth-policy'
import { hostingChargeResolutionController } from './hosting-charge-resolution-controller'
import { hostingConfiguration } from './hosting-configuration'
import { hostingCreditAllowanceController } from './hosting-credit-allowance-controller'
import { hostingLearningController } from './hosting-learning-controller'
import { hostingOnboardingController } from './hosting-onboarding-controller'
import { hostingOperatorController } from './hosting-operator-controller'
import { hostingPartnerAdminController } from './hosting-partner-admin-controller'
import { hostingPartnerBillingController } from './hosting-partner-billing-controller'
import { hostingPartnerSetupController, hostingPartnerSetupPublicController } from './hosting-partner-setup-controller'
import { hostingPricingController } from './hosting-pricing-controller'
import { hostingRecoveryController, hostingRecoveryPublicController } from './hosting-recovery-controller'
import { hostingServices } from './hosting-services'
import { hostingStorageController } from './hosting-storage-controller'
import { hostingStripeCatalogController } from './hosting-stripe-catalog-controller'
import { hostingStripeController } from './hosting-stripe-controller'
import { hostingSubscriptionController } from './hosting-subscription-controller'
import { hostingTenantJoinController, hostingTenantMembersController } from './hosting-tenant-members-controller'
import { hostingTrainerAdminController, hostingTrainerController, hostingTrainerSetupController } from './hosting-trainers-controller'
import { HostingActor, HostingError } from './hosting-transactions'

export const hostingController: FastifyPluginAsyncZod = async app => {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    await app.register(hostingChargeResolutionController, { prefix: '/operator/charge-resolutions' })
    await app.register(hostingStripeCatalogController, { prefix: '/operator/stripe-catalog' })
    await app.register(hostingCreditAllowanceController, { prefix: '/operator/credits-allowance' })
    await app.register(hostingSubscriptionController, { prefix: '/operator/subscriptions' })
    await app.register(hostingStorageController, { prefix: '/operator' })
    await app.register(hostingAccessController, { prefix: '/operator' })
    await app.register(hostingPartnerAdminController, { prefix: '/operator/partners' })
    await app.register(hostingAssessmentController, { prefix: '/operator/assessment' })
    await app.register(hostingRecoveryController, { prefix: '/operator/account-recovery' })
    await app.register(hostingRecoveryPublicController, { prefix: '/account-recovery' })
    await app.register(hostingTrainerAdminController, { prefix: '/operator/trainers' })
    await app.register(hostingTrainerController, { prefix: '/trainer' })
    await app.register(hostingTrainerSetupController, { prefix: '/trainer-setup' })
    await app.register(hostingPartnerSetupController, { prefix: '/operator/partner-setup' })
    await app.register(hostingPartnerSetupPublicController, { prefix: '/partner-setup' })
    await app.register(hostingTenantMembersController, { prefix: '/tenant-members' })
    await app.register(hostingTenantJoinController, { prefix: '/tenant-join' })
    await app.register(hostingLearningController, { prefix: '/operator' })
    await app.register(hostingOperatorController, { prefix: '/operator' })
    await app.register(hostingPricingController, { prefix: '/operator/ai-pricing' })
    await app.register(hostingOnboardingController, { prefix: '/onboarding' })
    await app.register(hostingStripeController, { prefix: '/billing' })
    await app.register(hostingPartnerBillingController, { prefix: '/partner-billing' })
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
        return grants.filter(grant => grant.meter === 'execution').map(grant => ({ meter: grant.meter, unit: grant.unit, amount: grant.amount.toString(), reserved: grant.reserved.toString(), consumed: grant.consumed.toString(), available: grant.available.toString(), microcreditsPerUnit: null, validUntil: grant.validUntil.toISOString() }))
    })
    // Hosted membership mutations require the current revision, immutable audit
    // record and issuer-bound one-time capability of the tenant-members API.
    for (const path of ['/invitations', '/invitations/accept']) app.post(path, { config: user }, async () => {
        throw new HostingError('HOSTING_TENANT_MEMBERS_REQUIRED')
    })
    app.delete('/invitations/:id', { config: user }, async () => {
        throw new HostingError('HOSTING_TENANT_MEMBERS_REQUIRED')
    })
    app.patch('/members/:id', { config: user }, async () => {
        throw new HostingError('HOSTING_TENANT_MEMBERS_REQUIRED')
    })
}

async function actor(request: FastifyRequest): Promise<HostingActor> {
    if (request.principal.type !== PrincipalType.USER) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
    const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
    if (user.platformId !== request.principal.platform.id) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
    return { identityId: user.identityId, platformId: request.principal.platform.id, tokenVersion: request.principal.tokenVersion ?? null }
}
