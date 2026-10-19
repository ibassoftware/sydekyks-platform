import { createHash, randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { PasswordType, UserIdentityProvider } from '@activepieces/shared'
import { DataSource, EntityManager, In, IsNull } from 'typeorm'
import { z } from 'zod'
import { passwordHasher } from '../authentication/lib/password-hasher'
import { OtpEntity } from '../authentication/otp/otp-entity'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { McpOAuthTokenEntity } from '../mcp/oauth/token/mcp-oauth-token.entity'
import { UserEntity } from '../user/user-entity'
import { HostingAccessRoleEntity } from './hosting-access-entities'
import { assertHostingOperator, hostingOperatorIdentityIds } from './hosting-access-policy'
import { HostingRecoveryBindingEntity, HostingRecoveryTokenEntity } from './hosting-recovery-entities'
import { isPrivilegedTrainerIdentity } from './hosting-trainer-policy'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const RecoverySecret = z.string().regex(/^[a-zA-Z0-9_-]{43}$/)
export const RecoveryCommand = z.strictObject({
    email: z.email().max(254).transform(value => value.trim().toLowerCase()), expectedRevision: z.number().int().min(0).max(1000),
    expectedState: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
    identityVerificationConfirmed: z.literal(true), verificationReason: z.string().trim().min(10).max(1000), verificationEvidence: z.string().trim().min(10).max(1000),
})
export const RecoveryRedeem = z.strictObject({ token: RecoverySecret, password: PasswordType })
const TTL_MS = 30 * 60_000
export function createHostedRecovery({ dataSource }: { dataSource: DataSource }) {
    async function status({ actor, email }: { actor: HostingActor, email: string }) {
        return tx.run({ dataSource, fn: async manager => {
            const operator = await assertHostingOperator({ manager, actor })
            const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ email: email.trim().toLowerCase() })
            return { platformId: actor.platformId, userId: operator.id, ...await state(manager, identity?.id ?? null, actor.identityId) }
        } })
    }
    async function command({ actor, input, action }: { actor: HostingActor, input: z.input<typeof RecoveryCommand>, action: 'issue' | 'revoke' }) {
        const value = RecoveryCommand.parse(input), requestHash = hash({ action, ...value })
        try {
            return await tx.run({ dataSource, fn: async manager => {
                const operator = await assertHostingOperator({ manager, actor }), tokens = manager.getRepository(HostingRecoveryTokenEntity)
                const found = await manager.getRepository(UserIdentityEntity).findOneBy({ email: value.email })
                if (!found) hostingFail('HOSTING_RECOVERY_ACCOUNT_UNAVAILABLE')
                const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: found.id }, lock: { mode: 'pessimistic_write' } })
                if (!identity || identity.email !== value.email) hostingFail('HOSTING_RECOVERY_ACCOUNT_UNAVAILABLE')
                await assertRecoverable(manager, identity.id, actor.identityId)
                await manager.getRepository(UserIdentityEntity).findOneOrFail({ where: { id: actor.identityId }, lock: { mode: 'pessimistic_write' } })
                await assertHostingOperator({ manager, actor })
                const prior = await tokens.findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
                if (prior) {
                    if (prior.requestHash !== requestHash) hostingFail('HOSTING_RECOVERY_IDEMPOTENCY_CONFLICT')
                    return { platformId: actor.platformId, userId: operator.id, ...await state(manager, prior.identityId, actor.identityId), setupUrl: null, replayed: true }
                }
                const current = await state(manager, identity.id, actor.identityId)
                if (current.revision !== value.expectedRevision || current.stateHash !== value.expectedState) hostingFail('HOSTING_RECOVERY_REVISION_CONFLICT')
                if (current.revision >= 1000) hostingFail('HOSTING_RECOVERY_HISTORY_LIMIT')
                const now = await tx.now(manager), revision = current.revision + 1, secret = action === 'issue' ? randomBytes(32).toString('base64url') : null
                await tokens.update({ identityId: identity.id, action: 'issue', usedAt: IsNull(), revokedAt: IsNull() }, { revokedAt: now })
                await tokens.insert({ id: apId(), identityId: identity.id, identityEmail: identity.email, identityTokenVersion: identity.tokenVersion ?? null, operatorIdentityId: actor.identityId, operatorPlatformId: actor.platformId, operatorTokenVersion: actor.tokenVersion ?? null, revision, requestKey: value.requestKey, requestHash, action, tokenDigest: secret ? hash(secret) : null, expiresAt: new Date(now.getTime() + TTL_MS), usedAt: null, revokedAt: action === 'revoke' ? now : null, method: 'manual_recovery', emailOwnershipVerified: false, verificationReason: value.verificationReason, verificationEvidence: value.verificationEvidence })
                await manager.getRepository(HostingRecoveryBindingEntity).save({ id: identity.id, revision })
                await tx.event({ manager, platformId: actor.platformId, event: `identity.recovery.${action}`, payload: { actorIdentityId: actor.identityId, identityId: identity.id, revision, method: 'manual_recovery', emailOwnershipVerified: false } })
                const url = secret ? new URL('/account-recovery', system.getOrThrow(AppSystemProp.FRONTEND_URL)) : null
                if (url) url.hash = `token=${secret}`
                return { platformId: actor.platformId, userId: operator.id, ...await state(manager, identity.id, actor.identityId), setupUrl: url?.href ?? null, replayed: false }
            } })
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') hostingFail('HOSTING_RECOVERY_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    async function inspect(token: string) {
        RecoverySecret.parse(token)
        return tx.run({ dataSource, fn: async manager => {
            const { link } = await usable(manager, token)
            return { email: link.identityEmail, expiresAt: link.expiresAt.toISOString(), method: 'manual_recovery' as const, emailOwnershipVerified: false }
        } })
    }
    async function redeem(input: z.input<typeof RecoveryRedeem>) {
        const value = RecoveryRedeem.parse(input), password = await passwordHasher.hash(value.password)
        return tx.run({ dataSource, fn: async manager => {
            const { identity, link } = await usable(manager, value.token), now = await tx.now(manager)
            await manager.getRepository(UserIdentityEntity).update({ id: identity.id }, { password, tokenVersion: apId() })
            const users = await manager.getRepository(UserEntity).find({ where: { identityId: identity.id }, select: ['id'] })
            if (users.length) await manager.getRepository(McpOAuthTokenEntity).update({ userId: In(users.map(user => user.id)) }, { revoked: true })
            await manager.getRepository(OtpEntity).delete({ identityId: identity.id })
            await manager.getRepository(HostingRecoveryTokenEntity).update({ id: link.id }, { usedAt: now })
            await manager.getRepository(HostingRecoveryTokenEntity).update({ identityId: identity.id, action: 'issue', usedAt: IsNull(), revokedAt: IsNull() }, { revokedAt: now })
            await tx.event({ manager, platformId: link.operatorPlatformId, event: 'identity.recovery.completed', payload: { recoveryId: link.id, identityId: identity.id, actorIdentityId: link.operatorIdentityId, method: 'manual_recovery', emailOwnershipVerified: false } })
            return { completed: true, email: identity.email, method: 'manual_recovery' as const, emailOwnershipVerified: false }
        } })
    }
    return { status, command, inspect, redeem }
}
async function assertRecoverable(manager: EntityManager, identityId: string, issuerIdentityId: string): Promise<void> {
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: identityId })
    if (!identity?.verified || identity.provider !== UserIdentityProvider.EMAIL || identity.id === issuerIdentityId || hostingOperatorIdentityIds().includes(identity.id) || await manager.getRepository(HostingAccessRoleEntity).existsBy({ id: identityId, role: 'team' }) || await isPrivilegedTrainerIdentity(manager, identityId)) hostingFail('HOSTING_RECOVERY_ACCOUNT_UNAVAILABLE')
}
async function usable(manager: EntityManager, token: string) {
    const digest = hash(token), found = await manager.getRepository(HostingRecoveryTokenEntity).findOneBy({ tokenDigest: digest, action: 'issue' })
    if (!found) hostingFail('HOSTING_RECOVERY_LINK_UNAVAILABLE')
    const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: found.identityId }, lock: { mode: 'pessimistic_write' } })
    const link = await manager.getRepository(HostingRecoveryTokenEntity).findOne({ where: { id: found.id, tokenDigest: digest }, lock: { mode: 'pessimistic_write' } })
    const binding = await manager.getRepository(HostingRecoveryBindingEntity).findOneBy({ id: found.identityId }), now = await tx.now(manager)
    if (!identity || !link || binding?.revision !== link.revision || link.usedAt || link.revokedAt || link.expiresAt <= now || identity.email !== link.identityEmail || (identity.tokenVersion ?? null) !== link.identityTokenVersion) hostingFail('HOSTING_RECOVERY_LINK_UNAVAILABLE')
    await manager.getRepository(UserIdentityEntity).findOneOrFail({ where: { id: link.operatorIdentityId }, lock: { mode: 'pessimistic_write' } })
    await assertHostingOperator({ manager, actor: { identityId: link.operatorIdentityId, platformId: link.operatorPlatformId, tokenVersion: link.operatorTokenVersion } })
    await assertRecoverable(manager, identity.id, link.operatorIdentityId)
    if (link.expiresAt <= await tx.now(manager)) hostingFail('HOSTING_RECOVERY_LINK_UNAVAILABLE')
    return { identity, link }
}
async function state(manager: EntityManager, identityId: string | null, issuerIdentityId: string) {
    const identity = identityId ? await manager.getRepository(UserIdentityEntity).findOneBy({ id: identityId }) : null
    const binding = identityId ? await manager.getRepository(HostingRecoveryBindingEntity).findOneBy({ id: identityId }) : null
    const latest = identityId ? await manager.getRepository(HostingRecoveryTokenEntity).findOne({ where: { identityId, action: 'issue' }, order: { revision: 'DESC' } }) : null
    const now = await tx.now(manager)
    let eligible = false
    if (identity) {
        try {
            await assertRecoverable(manager, identity.id, issuerIdentityId); eligible = true 
        }
        catch (error) {
            if (!(error instanceof HostingError)) throw error 
        }
    }
    let issuerCurrent = false
    if (latest) {
        try {
            await assertHostingOperator({ manager, actor: { identityId: latest.operatorIdentityId, platformId: latest.operatorPlatformId, tokenVersion: latest.operatorTokenVersion } }); issuerCurrent = true 
        }
        catch (error) {
            if (!(error instanceof HostingError)) throw error 
        }
    }
    const snapshot = { identityId: identity?.id ?? null, email: identity?.email ?? null, version: identity?.tokenVersion ?? null, revision: binding?.revision ?? 0, eligible }
    return { identityId: identity?.id ?? null, revision: binding?.revision ?? 0, stateHash: hash(snapshot), eligible, pending: eligible && issuerCurrent && !!latest && !latest.usedAt && !latest.revokedAt && latest.expiresAt > now && (identity?.tokenVersion ?? null) === latest.identityTokenVersion, expiresAt: latest?.expiresAt.toISOString() ?? null }
}
function hash(value: unknown): string {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex') 
}
