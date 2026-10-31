import { ActivepiecesError, apId, ErrorCode } from '@activepieces/core-utils'
import { OtpType, UserIdentityProvider } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { In, IsNull } from 'typeorm'
import { databaseConnection } from '../database/database-connection'
import { McpOAuthTokenEntity } from '../mcp/oauth/token/mcp-oauth-token.entity'
import { UserEntity } from '../user/user-entity'
import { passwordHasher } from './lib/password-hasher'
import { OtpEntity } from './otp/otp-entity'
import { otpService } from './otp/otp-service'
import { UserIdentityEntity } from './user-identity/user-identity-entity'
import { userIdentityService } from './user-identity/user-identity-service'

function refused(): never {
    throw new ActivepiecesError({ code: ErrorCode.INVALID_CREDENTIALS, params: null })
}

export const passwordService = (log: FastifyBaseLogger) => ({
    async isResetValid({ identityId, otp }: { identityId: string, otp: string }): Promise<boolean> {
        const identity = await databaseConnection().getRepository(UserIdentityEntity).findOneBy({ id: identityId })
        return !!identity?.verified && identity.provider === UserIdentityProvider.EMAIL && await otpService(log).isPasswordResetValid({ identityId, value: otp })
    },
    async change({ identityId, currentPassword, newPassword, tokenVersion }: { identityId: string, currentPassword: string, newPassword: string, tokenVersion: string | null }): Promise<void> {
        const identity = await userIdentityService(log).getOneOrFail({ id: identityId })
        if (!identity.verified || identity.provider !== UserIdentityProvider.EMAIL || (identity.tokenVersion ?? null) !== tokenVersion || !await passwordHasher.compare(currentPassword, identity.password)) refused()
        await replacePassword(identity, newPassword)
    },
    async reset({ identityId, otp, newPassword }: { identityId: string, otp: string, newPassword: string }): Promise<void> {
        const identity = await databaseConnection().getRepository(UserIdentityEntity).findOneBy({ id: identityId })
        if (!identity?.verified || identity.provider !== UserIdentityProvider.EMAIL || !await otpService(log).confirm({ identityId, type: OtpType.PASSWORD_RESET, value: otp })) refused()
        await replacePassword(identity, newPassword)
    },
})

// Compare the exact credential revision after hashing: a stale session, code or
// concurrent reset cannot overwrite a password that has already changed.
export async function replacePassword(identity: { id: string, password: string, tokenVersion?: string | null }, newPassword: string): Promise<void> {
    const password = await passwordHasher.hash(newPassword)
    await databaseConnection().transaction(async manager => {
        const changed = await manager.getRepository(UserIdentityEntity).createQueryBuilder().update().set({ password, tokenVersion: apId() }).where({ id: identity.id, password: identity.password, tokenVersion: identity.tokenVersion ?? IsNull() }).returning(['id']).execute()
        if (!Array.isArray(changed.raw) || changed.raw.length !== 1) refused()
        await revokePasswordSessions(manager, identity.id)
    })
}

export async function revokePasswordSessions(manager: import('typeorm').EntityManager, identityId: string): Promise<void> {
    await manager.getRepository(OtpEntity).delete({ identityId })
    const users = await manager.getRepository(UserEntity).find({ where: { identityId }, select: ['id'] })
    if (users.length) await manager.getRepository(McpOAuthTokenEntity).update({ userId: In(users.map(user => user.id)) }, { revoked: true })
}
