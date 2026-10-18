import { createHash, randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { cryptoUtils } from '@activepieces/server-utils'
import { MAX_FULL_NAME_LENGTH, PasswordType, UserIdentityProvider } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { DataSource, EntityManager, IsNull } from 'typeorm'
import { z } from 'zod'
import { passwordHasher } from '../authentication/lib/password-hasher'
import { signupNames } from '../authentication/lib/signup-names'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { UserEntity } from '../user/user-entity'
import { HostingAccessRoleEntity } from './hosting-access-entities'
import { assertHostingOperator, hostingOperatorIdentityIds } from './hosting-access-policy'
import { HostingPartnerSetupBindingEntity, HostingPartnerSetupTokenEntity } from './hosting-partner-setup-entities'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const PartnerSetupCommand = z.strictObject({ email: z.email().max(254).transform(email => email.trim().toLowerCase()), expectedRevision: z.number().int().min(0).max(1000), requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/) })
export const PartnerSetupSecret = z.string().regex(/^[a-zA-Z0-9_-]{43}$/)
export const PartnerSetupRedeem = z.strictObject({ token: PartnerSetupSecret, password: PasswordType, fullName: z.string().trim().min(1).max(MAX_FULL_NAME_LENGTH) })
const TTL_MS = 24 * 60 * 60_000

export function createHostedPartnerSetup({ dataSource, log }: { dataSource: DataSource, log: FastifyBaseLogger }) {
    async function status({ actor, email }: { actor: HostingActor, email: string }) {
        return tx.run({ dataSource, fn: async manager => {
            const operator = await assertHostingOperator({ manager, actor })
            const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ email: email.trim().toLowerCase() })
            return { platformId: actor.platformId, userId: operator.id, ...await state(manager, identity?.id ?? null) }
        } })
    }
    async function command({ actor, input, action }: { actor: HostingActor, input: z.input<typeof PartnerSetupCommand>, action: 'issue' | 'revoke' }) {
        const value = PartnerSetupCommand.parse(input), requestHash = hash({ action, ...value })
        const secret = action === 'issue' ? randomBytes(32).toString('base64url') : null
        try {
            return await tx.run({ dataSource, fn: async manager => {
                let operator = await assertHostingOperator({ manager, actor })
                const tokens = manager.getRepository(HostingPartnerSetupTokenEntity)
                const prior = await tokens.findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
                if (prior) {
                    if (prior.requestHash !== requestHash) hostingFail('HOSTING_SETUP_IDEMPOTENCY_CONFLICT')
                    return { platformId: actor.platformId, userId: operator.id, ...await state(manager, prior.identityId), setupUrl: null, replayed: true }
                }
                let found = await manager.getRepository(UserIdentityEntity).findOneBy({ email: value.email })
                if (!found) {
                    if (action !== 'issue') hostingFail('HOSTING_SETUP_ACCOUNT_UNAVAILABLE')
                    found = await userIdentityService(log).create({ email: value.email, password: await cryptoUtils.generateRandomPassword(), firstName: signupNames.firstNameFromEmail(value.email), lastName: '', provider: UserIdentityProvider.EMAIL, verified: false, trackEvents: false, newsLetter: false }, manager)
                }
                const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: found.id }, lock: { mode: 'pessimistic_write' } })
                if (!identity || identity.email !== value.email) hostingFail('HOSTING_SETUP_ACCOUNT_UNAVAILABLE')
                if (action === 'issue') await assertUnusedIdentity(manager, identity.id, actor.identityId)
                const binding = await manager.getRepository(HostingPartnerSetupBindingEntity).findOneBy({ id: identity.id })
                if ((binding?.revision ?? 0) !== value.expectedRevision) hostingFail('HOSTING_SETUP_REVISION_CONFLICT')
                if ((binding?.revision ?? 0) >= 1000) hostingFail('HOSTING_SETUP_HISTORY_LIMIT')
                operator = await assertHostingOperator({ manager, actor })
                const now = await tx.now(manager), revision = (binding?.revision ?? 0) + 1
                await tokens.update({ identityId: identity.id, action: 'issue', usedAt: IsNull(), revokedAt: IsNull() }, { revokedAt: now })
                await tokens.insert({ id: apId(), identityId: identity.id, identityEmail: identity.email, identityTokenVersion: identity.tokenVersion ?? null, operatorIdentityId: actor.identityId, operatorPlatformId: actor.platformId, operatorTokenVersion: actor.tokenVersion ?? null, revision, requestKey: value.requestKey, requestHash, action, tokenDigest: secret ? hash(secret) : null, expiresAt: new Date(now.getTime() + TTL_MS), usedAt: null, revokedAt: action === 'revoke' ? now : null, method: 'operator', emailOwnershipVerified: false })
                await manager.getRepository(HostingPartnerSetupBindingEntity).save({ id: identity.id, revision })
                await tx.event({ manager, platformId: actor.platformId, event: `operational.partner.setup.${action}`, payload: { actorIdentityId: actor.identityId, identityId: identity.id, revision, method: 'operator', emailOwnershipVerified: false } })
                const url = secret ? new URL('/partner-setup', system.getOrThrow(AppSystemProp.FRONTEND_URL)) : null
                if (url) url.hash = `token=${secret}`
                return { platformId: actor.platformId, userId: operator.id, ...await state(manager, identity.id), setupUrl: url?.href ?? null, replayed: false }
            } })
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') hostingFail('HOSTING_SETUP_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    async function inspect(token: string) {
        PartnerSetupSecret.parse(token)
        return tx.run({ dataSource, fn: async manager => {
            const { link } = await usable(manager, token)
            return { email: link.identityEmail, expiresAt: link.expiresAt.toISOString(), method: 'operator' as const, emailOwnershipVerified: false }
        } })
    }
    async function redeem(input: z.input<typeof PartnerSetupRedeem>) {
        const value = PartnerSetupRedeem.parse(input)
        // Do expensive hashing before taking the identity lock. The token and
        // every authority/version/expiry guard are rechecked inside the lock.
        const password = await passwordHasher.hash(value.password)
        return tx.run({ dataSource, fn: async manager => {
            const { link, identity } = await usable(manager, value.token)
            const names = signupNames.splitFullName({ fullName: value.fullName, email: identity.email })
            const now = await tx.now(manager)
            // verified is the legacy login-eligibility flag. This path attests
            // manual operator admission, never ownership of an email inbox.
            await manager.getRepository(UserIdentityEntity).update({ id: identity.id }, { password, ...names, verified: true, tokenVersion: apId() })
            await manager.getRepository(HostingPartnerSetupTokenEntity).update({ id: link.id }, { usedAt: now })
            await tx.event({ manager, platformId: link.operatorPlatformId, event: 'operational.partner.setup.completed', payload: { actorIdentityId: link.operatorIdentityId, identityId: identity.id, method: 'operator', emailOwnershipVerified: false, setupId: link.id } })
            return { completed: true, email: identity.email, method: 'operator' as const, emailOwnershipVerified: false, status: 'awaiting_partner_approval' as const }
        } })
    }
    return { status, command, inspect, redeem }
}

async function assertUnusedIdentity(manager: EntityManager, identityId: string, issuerIdentityId: string) {
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: identityId })
    const role = await manager.getRepository(HostingAccessRoleEntity).findOneBy({ id: identityId })
    if (!identity || identity.verified || identityId === issuerIdentityId || hostingOperatorIdentityIds().includes(identityId) || role || await manager.getRepository(UserEntity).existsBy({ identityId })) hostingFail('HOSTING_SETUP_ACCOUNT_UNAVAILABLE')
}
async function usable(manager: EntityManager, token: string) {
    const digest = hash(token)
    const found = await manager.getRepository(HostingPartnerSetupTokenEntity).findOneBy({ tokenDigest: digest, action: 'issue' })
    if (!found) hostingFail('HOSTING_SETUP_LINK_UNAVAILABLE')
    // Issuance/reissue and redemption always lock target identity first.
    const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: found.identityId }, lock: { mode: 'pessimistic_write' } })
    const link = await manager.getRepository(HostingPartnerSetupTokenEntity).findOne({ where: { id: found.id, tokenDigest: digest }, lock: { mode: 'pessimistic_write' } })
    const binding = await manager.getRepository(HostingPartnerSetupBindingEntity).findOneBy({ id: found.identityId })
    const now = await tx.now(manager)
    if (!binding || binding.revision !== link?.revision || !identity || !link || link.usedAt || link.revokedAt || link.expiresAt <= now || identity.email !== link.identityEmail || (identity.tokenVersion ?? null) !== link.identityTokenVersion) hostingFail('HOSTING_SETUP_LINK_UNAVAILABLE')
    await assertUnusedIdentity(manager, identity.id, link.operatorIdentityId)
    await assertHostingOperator({ manager, actor: { identityId: link.operatorIdentityId, platformId: link.operatorPlatformId, tokenVersion: link.operatorTokenVersion } })
    return { link, identity }
}
async function state(manager: EntityManager, identityId: string | null) {
    if (!identityId) return { identityId: null, revision: 0, pending: false, expiresAt: null }
    const binding = await manager.getRepository(HostingPartnerSetupBindingEntity).findOneBy({ id: identityId })
    const latest = await manager.getRepository(HostingPartnerSetupTokenEntity).findOne({ where: { identityId, action: 'issue' }, order: { revision: 'DESC' } })
    const now = await tx.now(manager)
    return { identityId, revision: binding?.revision ?? 0, pending: !!latest && !latest.usedAt && !latest.revokedAt && latest.expiresAt > now, expiresAt: latest?.expiresAt.toISOString() ?? null }
}
function hash(value: unknown): string {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}
