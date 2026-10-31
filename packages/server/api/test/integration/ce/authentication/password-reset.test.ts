import { OtpType, PrincipalType, UserIdentityProvider } from '@activepieces/shared'
import { FastifyInstance } from 'fastify'
import { vi } from 'vitest'
import { accessTokenManager } from '../../../../src/app/authentication/lib/access-token-manager'
import { passwordHasher } from '../../../../src/app/authentication/lib/password-hasher'
import { otpService } from '../../../../src/app/authentication/otp/otp-service'
import { passwordService, replacePassword } from '../../../../src/app/authentication/password-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { distributedStore } from '../../../../src/app/database/redis-connections'
import { createMockPlatform, createMockUser, createMockUserIdentity } from '../../../helpers/mocks'
import { setupTestEnvironment } from '../../../helpers/test-setup'

const delivery = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../../src/app/sydekyks-community/email', () => ({ emailService: () => ({ sendOtp: delivery.send }), smtpEmailSender: () => ({ isSmtpConfigured: () => true }) }))
let app: FastifyInstance
const originalPassword = 'Synthetic-old-password-42!', newPassword = 'Synthetic-new-password-43!'
async function seed() {
    const identity = createMockUserIdentity({ verified: true, password: originalPassword, tokenVersion: 'initial-session' })
    const user = createMockUser({ identityId: identity.id })
    const platform = createMockPlatform({ ownerId: user.id, emailAuthEnabled: true })
    user.platformId = platform.id
    const db = databaseConnection()
    await db.getRepository('user_identity').save(identity)
    await db.getRepository('platform').save(platform)
    await db.getRepository('user').save(user)
    const token = await accessTokenManager(app.log).generateToken({ type: PrincipalType.USER, id: user.id, platform: { id: platform.id }, tokenVersion: identity.tokenVersion })
    return { identity, user, token }
}
async function issue(identity: { id: string, email: string }) {
    await otpService(app.log).createAndSend({ platformId: null, email: identity.email, type: OtpType.PASSWORD_RESET })
    return (await distributedStore.get<string>(`otp-pending-code:${identity.id}:${OtpType.PASSWORD_RESET}`))!
}
beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true }) 
})
beforeEach(() => delivery.send.mockClear())

it('uses a registered reset endpoint, accepts one emailed code once, and invalidates old sessions', async () => {
    const { identity, token } = await seed(), otp = await issue(identity)
    const reset = await app.inject({ method: 'POST', url: '/api/v1/authentication/reset-password', body: { identityId: identity.id, otp, newPassword } })
    expect(reset.statusCode).toBe(204)
    const saved = await databaseConnection().getRepository('user_identity').findOneByOrFail({ id: identity.id })
    expect(await passwordHasher.compare(newPassword, saved.password)).toBe(true)
    await expect(accessTokenManager(app.log).verifyPrincipal(token)).rejects.toThrow()
    expect((await app.inject({ method: 'POST', url: '/api/v1/authentication/reset-password', body: { identityId: identity.id, otp, newPassword } })).statusCode).not.toBe(204)
})
it('requires the current password, rotates sessions and discards earlier recovery codes', async () => {
    const { identity, token } = await seed(), otp = await issue(identity)
    const post = (currentPassword: string) => app.inject({ method: 'POST', url: '/api/v1/authentication/change-password', headers: { authorization: `Bearer ${token}` }, body: { currentPassword, newPassword } })
    expect((await post('wrong-password')).statusCode).not.toBe(204)
    expect((await post(originalPassword)).statusCode).toBe(204)
    await expect(accessTokenManager(app.log).verifyPrincipal(token)).rejects.toThrow()
    await expect(passwordService(app.log).reset({ identityId: identity.id, otp, newPassword: originalPassword })).rejects.toThrow()
})
it('rejects expired links, unverified accounts and federated identities', async () => {
    const { identity } = await seed(), otp = await issue(identity)
    await databaseConnection().getRepository('otp').query('UPDATE otp SET updated = $1 WHERE "identityId" = $2', [new Date(Date.now() - 11 * 60_000).toISOString(), identity.id])
    await expect(passwordService(app.log).reset({ identityId: identity.id, otp, newPassword })).rejects.toThrow()
    for (const update of [{ verified: false }, { verified: true, provider: UserIdentityProvider.GOOGLE }]) {
        await databaseConnection().getRepository('user_identity').update(identity.id, update)
        await expect(passwordService(app.log).change({ identityId: identity.id, tokenVersion: 'initial-session', currentPassword: originalPassword, newPassword })).rejects.toThrow()
    }
})
it('does not allow two concurrent stale password writes to overwrite each other', async () => {
    const { identity } = await seed()
    const results = await Promise.allSettled([replacePassword(identity, newPassword), replacePassword(identity, 'Synthetic-other-password-44!')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
})
it('returns the same empty response for eligible and absent accounts and does not disclose mail failures', async () => {
    vi.stubEnv('AP_API_RATE_LIMIT_AUTHN_ENABLED', 'true')
    const { identity } = await seed()
    delivery.send.mockRejectedValueOnce(new Error('Synthetic mail failure'))
    for (const email of [identity.email, 'absent-recovery-account@example.invalid']) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/authentication/request-password-reset', body: { email } })
        expect(response.statusCode).toBe(204); expect(response.body).toBe('')
    }
    vi.unstubAllEnvs()
})
