import { OtpType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { emailService } from '../../src/app/sydekyks-community/email'
import { createMockUserIdentity } from '../helpers/mocks'

const smtp = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => smtp } }))
afterEach(() => {
    vi.unstubAllEnvs(); vi.clearAllMocks() 
})
it('emails a Sydekyks reset link with the one-time credential in a fragment and an expiry explanation', async () => {
    for (const [name, value] of Object.entries({ FRONTEND_URL: 'https://app.example.invalid', SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '587', SMTP_USERNAME: 'synthetic-user', SMTP_PASSWORD: 'synthetic-password', SMTP_SENDER_EMAIL: 'accounts@example.invalid' })) vi.stubEnv('AP_' + name, value)
    const identity = createMockUserIdentity({ verified: true }), otp = 'synthetic-single-use-code'
    await emailService({} as FastifyBaseLogger).sendOtp({ userIdentity: identity, type: OtpType.PASSWORD_RESET, otp })
    const message = smtp.sendMail.mock.calls[0][0]
    const url = new URL(message.text.match(/https:\/\/\S+/)[0])
    expect(url.pathname).toBe('/reset-password')
    expect(url.search).toBe('')
    expect(new URLSearchParams(url.hash.slice(1)).get('otpcode')).toBe(otp)
    expect(new URLSearchParams(url.hash.slice(1)).get('identityId')).toBe(identity.id)
    expect(message.to).toBe(identity.email)
    expect(message.subject).toBe('Reset your Sydekyks password')
    expect(message.text).toContain('10 minutes')
    expect(smtp.close).toHaveBeenCalledOnce()
})
