import { OtpType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { turnstile } from '../authentication/lib/turnstile'
import { otpService } from '../authentication/otp/otp-service'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { smtpEmailSender } from '../sydekyks-community/email'
import { hostingConfiguration } from './hosting-configuration'
import { hostingFail } from './hosting-transactions'

export function hostedEmailCodesAvailable(log: FastifyBaseLogger): boolean {
    return hostingConfiguration.getServiceMode() === 'hosted' && smtpEmailSender(log).isSmtpConfigured() && turnstile.isConfigured() && system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED) === true
}
export function assertHostedEmailCodes(log: FastifyBaseLogger): void {
    if (!hostedEmailCodesAvailable(log)) hostingFail('HOSTING_SIGNUP_UNAVAILABLE')
}
export async function resendHostedVerification({ email, captchaToken, remoteIp, log }: { email: string, captchaToken?: string, remoteIp: string, log: FastifyBaseLogger }): Promise<void> {
    assertHostedEmailCodes(log)
    await turnstile.assertSolved({ token: captchaToken, remoteIp, log, failClosed: true })
    const identity = await userIdentityService(log).getIdentityByEmail(email)
    if (identity && !identity.verified) {
        try {
            await otpService(log).createAndSend({ platformId: null, email: identity.email, type: OtpType.EMAIL_VERIFICATION })
        }
        catch {
            log.warn('Hosted verification delivery failed')
        }
    }
}
