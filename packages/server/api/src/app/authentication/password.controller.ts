import { createHash } from 'node:crypto'
import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { EmailType, OtpType, PasswordType, PrincipalType, ResetPasswordRequestBody, UserIdentityProvider } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit, emailCodeRateLimit } from '../core/security/rate-limit'
import { distributedStore } from '../database/redis-connections'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { smtpEmailSender } from '../sydekyks-community/email'
import { userService } from '../user/user-service'
import { otpService } from './otp/otp-service'
import { passwordService } from './password-service'
import { userIdentityService } from './user-identity/user-identity-service'

export const passwordController: FastifyPluginAsyncZod = async app => {
    app.post('/request-password-reset', {
        config: { security: securityAccess.public(), rateLimit: emailCodeRateLimit },
        logLevel: 'silent', bodyLimit: 4096,
        schema: { body: z.strictObject({ email: EmailType }) },
    }, async (request, reply) => {
        void reply.header('Cache-Control', 'no-store')
        if (!smtpEmailSender(request.log).isSmtpConfigured() || system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED) !== true) {
            return reply.code(503).send({ code: 'PASSWORD_RECOVERY_UNAVAILABLE' })
        }
        const email = request.body.email.trim().toLowerCase()
        const key = 'password-reset-request:' + createHash('sha256').update(email).digest('hex')
        const maySend = await distributedStore.putIfAbsent(key, true, 60)
        // Delivery runs outside the response path for both existing and absent
        // accounts. SMTP failures and account eligibility never change the reply.
        if (maySend) rejectedPromiseHandler((async () => {
            try {
                const identity = await userIdentityService(request.log).getIdentityByEmail(email)
                if (identity?.verified && identity.provider === UserIdentityProvider.EMAIL) await otpService(request.log).createAndSend({ platformId: null, email, type: OtpType.PASSWORD_RESET })
            }
            catch {
                request.log.warn('Password recovery delivery failed') 
            }
        })(), request.log)
        return reply.code(204).send()
    })
    app.post('/reset-password', {
        config: { security: securityAccess.public(), rateLimit: authnRateLimit },
        logLevel: 'silent', bodyLimit: 4096,
        schema: { body: ResetPasswordRequestBody.extend({ otp: z.string().min(1).max(128), newPassword: PasswordType }) },
    }, async (request, reply) => {
        void reply.header('Cache-Control', 'no-store')
        await passwordService(request.log).reset(request.body)
        return reply.code(204).send()
    })
    app.post('/change-password', {
        config: { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit },
        logLevel: 'silent', bodyLimit: 4096,
        schema: { body: z.strictObject({ currentPassword: z.string().min(1).max(64), newPassword: PasswordType }) },
    }, async (request, reply) => {
        if (request.principal.type !== PrincipalType.USER) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
        const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
        await passwordService(request.log).change({ ...request.body, identityId: user.identityId, tokenVersion: request.principal.tokenVersion ?? null })
        return reply.header('Cache-Control', 'no-store').code(204).send()
    })

}
