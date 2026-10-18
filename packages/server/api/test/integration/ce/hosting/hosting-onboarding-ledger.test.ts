import { randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { PlatformRole, UserStatus } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../../../src/app/authentication/user-identity/user-identity-entity'
import { commonProperties } from '../../../../src/app/database/database-connection'
import { SydekyksHostingLedger1882000000000 } from '../../../../src/app/database/migration/postgres/1882000000000-SydekyksHostingLedger'
import { getMigrations } from '../../../../src/app/database/postgres-connection'
import { FlagEntity } from '../../../../src/app/flags/flag.entity'
import { HostingAccountEntity, HostingDailyBudgetEntity, HostingEligibilityEntity, HostingGrantEntity, HostingInvitationEntity, HostingLedgerEntity, HostingOutboxEntity, HostingReservationEntity } from '../../../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../../../src/app/hosting/hosting-onboarding'
import { McpOAuthTokenEntity } from '../../../../src/app/mcp/oauth/token/mcp-oauth-token.entity'
import { PlatformEntity } from '../../../../src/app/platform/platform.entity'
import { ProjectEntity } from '../../../../src/app/project/project-entity'
import { UserEntity } from '../../../../src/app/user/user-entity'
import { bootstrapHostedOperator } from '../../../helpers/hosting-fixtures'

const schema = `hosting_ledger_${randomBytes(6).toString('hex')}`
const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(process.env['HOSTING_TEST_POSTGRES_PORT'] ?? '55439'), username: process.env['HOSTING_TEST_POSTGRES_USER'] ?? 'hosting_tests', password: process.env['HOSTING_TEST_POSTGRES_PASSWORD'] ?? 'disposable-only', database: process.env['HOSTING_TEST_POSTGRES_DATABASE'] ?? 'hosting_tests', schema, extra: { options: `-c search_path=${schema},public` }, ...commonProperties })
const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-stable-subject-secret-32-characters' })
const ledger = createHostedLedger({ dataSource: ds })
const migration = new SydekyksHostingLedger1882000000000()

beforeAll(async () => {
    await ds.initialize()
    await ds.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
    const runner = ds.createQueryRunner()
    await runner.createSchema(schema, true)
    try {
        await runner.startTransaction()
        for (const Migration of getMigrations()) await new Migration().up(runner)
        await runner.commitTransaction()
    }
    finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release()
    }
})
afterAll(async () => {
    if (ds.isInitialized) {
        await ds.query(`DROP SCHEMA "${schema}" CASCADE`); await ds.destroy()
    }
})
beforeEach(async () => {
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${schema}"."${entity.tableName}"`).join(', ')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
})

async function identity({ email = `${apId()}@example.com`, verified = true }: { email?: string, verified?: boolean } = {}) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email, password: 'unused-test-hash', provider: 'EMAIL', firstName: 'Test', lastName: 'Owner', verified, tokenVersion: 'initial' })
    return id
}
async function tenant(ordinaryAdmin = false) {
    const identityId = await identity()
    const previousAllowlist = process.env['AP_HOSTED_OPERATOR_IDENTITY_IDS'] ?? ''
    const value = await bootstrapHostedOperator(ds, onboarding, identityId)
    if (ordinaryAdmin) vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', previousAllowlist)
    if (!value.projectId) throw new Error('Missing project')
    return { ...value, projectId: value.projectId, actor: { platformId: value.platformId, identityId, ...(ordinaryAdmin ? { tokenVersion: value.tokenVersion } : {}) } }
}
async function running(payer: 'managed' | 'byok' = 'managed') {
    const value = await tenant()
    const reservation = await ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: 'execution', payer })
    const claim = await ledger.claimExecution({ actor: value.actor, reservationId: reservation.id })
    if (!claim.dispatchId) throw new Error('Missing execution fence')
    return { ...value, root: reservation, fence: { platformId: value.platformId, reservationId: reservation.id, dispatchId: claim.dispatchId } }
}
async function managed() {
    const value = await running()
    const reservation = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'call', maxCostMicroUsd: 100n })
    const claim = await ledger.claimManagedCall({ actor: value.actor, reservationId: reservation.id })
    if (!claim.dispatchId) throw new Error('Missing call fence')
    return { ...value, call: reservation, callFence: { platformId: value.platformId, reservationId: reservation.id, dispatchId: claim.dispatchId } }
}

describe('hosted tenant onboarding', () => {
    it('provisions concurrent verified retries once with trial grants and no card requirement', async () => {
        const identityId = await identity()
        const outcomes = await Promise.all(Array.from({ length: 8 }, () => bootstrapHostedOperator(ds, onboarding, identityId, 'Tenant')))
        expect(new Set(outcomes.map(value => value.platformId)).size).toBe(1)
        expect(outcomes.filter(value => value.created)).toHaveLength(1)
        expect(await ds.getRepository(PlatformEntity).count()).toBe(1)
        expect(await ds.getRepository(ProjectEntity).count()).toBe(1)
        expect(await ds.getRepository(HostingEligibilityEntity).count()).toBe(1)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(2)
        expect(await ds.getRepository(HostingOutboxEntity).count()).toBe(1)
        const grants = await ledger.balance({ actor: { identityId, platformId: outcomes[0].platformId } })
        expect(grants.find(value => value.meter === 'execution')?.available).toBe(1000n)
        const ai = grants.find(value => value.meter === 'managed_ai')
        expect(ai?.unit).toBe('micro_usd')
        expect(ai && ai.available * (ai.microcreditsPerUnit ?? 0n)).toBe(1_000_000_000n)
    })
    it('rejects unverified identities, self-hosted installation and stale sessions', async () => {
        const identityId = await identity({ verified: false })
        await expect(bootstrapHostedOperator(ds, onboarding, identityId, 'Tenant')).rejects.toThrow('HOSTING_VERIFIED_IDENTITY_REQUIRED')
        await ds.getRepository(UserIdentityEntity).update({ id: identityId }, { verified: true })
        await bootstrapHostedOperator(ds, onboarding, identityId, 'Tenant')
        await expect(onboarding.provision({ identityId, name: 'Tenant', expectedTokenVersion: 'initial' })).rejects.toThrow('HOSTING_SESSION_EXPIRED')
        await ds.getRepository(FlagEntity).update({ id: INSTALLATION_MODE_FLAG_ID }, { value: { schemaVersion: 1, serviceMode: 'self_hosted' } })
        await expect(bootstrapHostedOperator(ds, onboarding, identityId, 'Tenant')).rejects.toThrow('HOSTED_INSTALLATION_REQUIRED')
    })
    it('rolls back the whole account when the transactional outbox fails', async () => {
        const identityId = await identity()
        await ds.query('ALTER TABLE hosting_outbox ADD CONSTRAINT test_reject_event CHECK (false) NOT VALID')
        try {
            await expect(bootstrapHostedOperator(ds, onboarding, identityId, 'Tenant')).rejects.toThrow()
        }
        finally {
            await ds.query('ALTER TABLE hosting_outbox DROP CONSTRAINT test_reject_event')
        }
        expect(await ds.getRepository(PlatformEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingEligibilityEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingGrantEntity).count()).toBe(0)
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })).tokenVersion).toBe('initial')
    })
    it('retains trial eligibility across identity deletion and refuses secret rotation', async () => {
        const value = await tenant()
        const original = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: value.actor.identityId })
        const retainedOwner = apId()
        await ds.getRepository(UserEntity).insert({ id: retainedOwner, identityId: await identity(), platformId: value.platformId, platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE })
        await ds.getRepository(PlatformEntity).update({ id: value.platformId }, { ownerId: retainedOwner })
        await ds.getRepository(ProjectEntity).update({ id: value.projectId }, { ownerId: retainedOwner })
        await ds.getRepository(UserEntity).delete({ id: value.userId })
        await ds.getRepository(UserIdentityEntity).delete({ id: original.id })
        const replacement = await identity({ email: original.email })
        await expect(onboarding.provision({ identityId: replacement, name: 'Again' })).rejects.toThrow('HOSTING_TRIAL_ALREADY_USED')
        const rotated = createHostedOnboarding({ dataSource: ds, subjectSecret: 'another-synthetic-secret-with-32-characters' })
        await expect(rotated.provision({ identityId: replacement, name: 'Again' })).rejects.toThrow('HOSTING_SUBJECT_KEY_CHANGED')
    })
    it('does not renew an expired trial or allow trial invitations', async () => {
        const value = await tenant(true)
        await expect(onboarding.invite({ actor: value.actor, email: 'invite@example.com', role: PlatformRole.MEMBER })).rejects.toThrow('HOSTING_RESOURCE_LIMIT')
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { validUntil: new Date(0) })
        expect((await onboarding.provision({ identityId: value.actor.identityId, name: 'Again' })).platformId).toBe(value.platformId)
        await expect(ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: 'expired', payer: 'byok' })).rejects.toThrow('HOSTING_ENTITLEMENT_EXPIRED')
    })
    it('reserves the last seat/project atomically and accepts only the addressed verified identity', async () => {
        const value = await tenant(true)
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { planId: 'starter', status: 'active' })
        const invitation = await onboarding.invite({ actor: value.actor, email: 'one@example.com', role: PlatformRole.MEMBER })
        const invites = await Promise.allSettled(['two', 'three', 'four'].map(name => onboarding.invite({ actor: value.actor, email: `${name}@example.com`, role: PlatformRole.MEMBER })))
        expect(invites.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const pending = await ds.getRepository(HostingInvitationEntity).findBy({ platformId: value.platformId, status: 'pending' })
        expect(pending).toHaveLength(2)
        {
            const outsider = await identity()
            await expect(onboarding.acceptInvitation({ identityId: outsider, token: invitation.token })).rejects.toThrow('HOSTING_INVALID_INVITATION')
            const member = await identity({ email: 'one@example.com' })
            const accepted = await onboarding.acceptInvitation({ identityId: member, token: invitation.token })
            expect((await ds.getRepository(UserEntity).findOneByOrFail({ id: accepted.userId })).platformRole).toBe(PlatformRole.MEMBER)
            expect((await onboarding.acceptInvitation({ identityId: member, token: invitation.token })).userId).toBe(accepted.userId)
            expect((await onboarding.provision({ identityId: member, name: 'No additional trial' })).platformId).toBe(value.platformId)
            expect(await ds.getRepository(HostingAccountEntity).count()).toBe(1)
        }
    })
    it('reactivates a member at the project limit and rotates sessions/revokes MCP grants', async () => {
        const value = await tenant(true)
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { planId: 'starter' })
        const member = await identity({ email: 'member@example.com' })
        const invitation = await onboarding.invite({ actor: value.actor, email: 'member@example.com', role: PlatformRole.MEMBER })
        const joined = await onboarding.acceptInvitation({ identityId: member, token: invitation.token })
        const third = await onboarding.invite({ actor: value.actor, email: 'third@example.com', role: PlatformRole.OPERATOR })
        await onboarding.acceptInvitation({ identityId: await identity({ email: 'third@example.com' }), token: third.token })
        await ds.getRepository(McpOAuthTokenEntity).insert({ id: apId(), platformId: value.platformId, userId: joined.userId, projectId: joined.projectId, clientId: 'test', refreshToken: 'test-refresh', revoked: false, expiresAt: new Date(Date.now() + 86400000).toISOString() })
        const before = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: member })
        await onboarding.changeMember({ actor: value.actor, userId: joined.userId, deactivate: true })
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: member })).tokenVersion).not.toBe(before.tokenVersion)
        expect((await ds.getRepository(McpOAuthTokenEntity).findOneByOrFail({ userId: joined.userId })).revoked).toBe(true)
        await expect(onboarding.selectTenant({ actor: { identityId: member, platformId: value.platformId } })).rejects.toThrow('HOSTING_ACCESS_DENIED')
        const reinvite = await onboarding.invite({ actor: value.actor, email: 'member@example.com', role: PlatformRole.OPERATOR })
        expect((await onboarding.acceptInvitation({ identityId: member, token: reinvite.token })).projectId).toBe(joined.projectId)
        expect(await ds.getRepository(ProjectEntity).countBy({ platformId: value.platformId })).toBe(3)
        await expect(onboarding.changeMember({ actor: value.actor, userId: value.userId, deactivate: true })).rejects.toThrow('HOSTING_MEMBER_PROTECTED')
        expect(await ds.getRepository(UserEntity).findOneBy({ id: value.userId })).toMatchObject({ status: UserStatus.ACTIVE, platformRole: PlatformRole.ADMIN })
    })
    it('serializes accept/revoke races and denies cross-tenant or personal-project access', async () => {
        const value = await tenant(true)
        const other = await tenant()
        await expect(onboarding.selectTenant({ actor: { identityId: other.actor.identityId, platformId: value.platformId } })).rejects.toThrow('HOSTING_ACCESS_DENIED')
        await expect(ledger.reserveExecution({ actor: other.actor, projectId: value.projectId, key: 'cross', payer: 'byok' })).rejects.toThrow('HOSTING_PROJECT_ACCESS_DENIED')
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { planId: 'starter' })
        const invitation = await onboarding.invite({ actor: value.actor, email: 'race@example.com', role: PlatformRole.ADMIN })
        const identityId = await identity({ email: 'race@example.com' })
        const outcomes = await Promise.allSettled([onboarding.acceptInvitation({ identityId, token: invitation.token }), onboarding.revokeInvitation({ actor: value.actor, invitationId: invitation.id })])
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const stored = await ds.getRepository(HostingInvitationEntity).findOneByOrFail({ id: invitation.id })
        expect(await ds.getRepository(UserEntity).existsBy({ identityId, platformId: value.platformId })).toBe(stored.status === 'accepted')
        if (stored.status === 'accepted') await expect(ledger.reserveExecution({ actor: { identityId, platformId: value.platformId }, projectId: value.projectId, key: 'personal', payer: 'byok' })).rejects.toThrow('HOSTING_PROJECT_ACCESS_DENIED')
    })
})

describe('hosted credit and liability ledger', () => {
    it('serializes last-slot and last-credit races with idempotent execution keys', async () => {
        const value = await tenant()
        await ds.getRepository(HostingGrantEntity).update({ platformId: value.platformId, meter: 'execution' }, { amount: 1n })
        const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: `race:${i}`, payer: 'byok' })))
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const stored = await ds.getRepository(HostingReservationEntity).findOneByOrFail({ platformId: value.platformId })
        const retries = await Promise.all(Array.from({ length: 8 }, () => ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: stored.key, payer: 'byok' })))
        expect(new Set(retries.map(result => result.id)).size).toBe(1)
        await expect(ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: stored.key, payer: 'managed' })).rejects.toThrow('HOSTING_IDEMPOTENCY_CONFLICT')
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
    })
    it('fences duplicate dispatch, charges BYOK executions only, and finishes once', async () => {
        const value = await running('byok')
        expect((await ledger.claimExecution({ actor: value.actor, reservationId: value.root.id })).claimed).toBe(false)
        await expect(ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'forbidden', maxCostMicroUsd: 1n })).rejects.toThrow('HOSTING_BYOK_HAS_NO_MANAGED_ALLOWANCE')
        await expect(ledger.finishExecution({ ...value.fence, dispatchId: 'wrong' })).rejects.toThrow('HOSTING_DISPATCH_FENCE_MISMATCH')
        await ledger.finishExecution(value.fence)
        await ledger.finishExecution(value.fence)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).consumed).toBe(1n)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'managed_ai' })).consumed).toBe(0n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('reserves managed calls atomically against grant and shared daily cap', async () => {
        const value = await running()
        const today = new Date().toISOString().slice(0, 10)
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: today, reserved: 0n, consumed: 0n, limit: 100n })
        const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: `call:${i}`, maxCostMicroUsd: 100n })))
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: today })).reserved).toBe(100n)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'managed_ai' })).reserved).toBe(100n)
    })
    it('keeps uncertain liabilities reserved, disallows resend/refund and reconciles once', async () => {
        const value = await managed()
        await ledger.markUncertain(value.callFence)
        await ledger.markUncertain(value.callFence)
        expect((await ledger.claimManagedCall({ actor: value.actor, reservationId: value.call.id })).claimed).toBe(false)
        await expect(ledger.releaseUnsent({ actor: value.actor, reservationId: value.call.id })).rejects.toThrow('HOSTING_INVALID_TRANSITION')
        await expect(ledger.finishExecution(value.fence)).rejects.toThrow('HOSTING_UNSETTLED_CHILDREN')
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: value.call.grantId })).reserved).toBe(100n)
        await ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 40n })
        await ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 40n })
        await expect(ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 41n })).rejects.toThrow('HOSTING_IDEMPOTENCY_CONFLICT')
        await ledger.finishExecution(value.fence)
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: value.call.grantId })
        expect([grant.reserved, grant.consumed]).toEqual([0n, 40n])
        expect(await ds.getRepository(HostingLedgerEntity).countBy({ reservationId: value.call.id, operation: 'settle' })).toBe(1)
    })
    it('records over-bound actual cost and suspends further admission', async () => {
        const value = await managed()
        await ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 150n })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).status).toBe('suspended')
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: value.call.grantId })).consumed).toBe(150n)
        await ledger.finishExecution(value.fence)
        await expect(ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: 'blocked', payer: 'byok' })).rejects.toThrow('HOSTING_ENTITLEMENT_EXPIRED')
    })
    it('settles original period and UTC day even after expiry or membership revocation', async () => {
        const value = await managed()
        const originalDay = '2000-01-01'
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: originalDay, reserved: 100n, consumed: 0n, limit: 1000n })
        await ds.getRepository(HostingDailyBudgetEntity).update({ id: value.call.day ?? '' }, { reserved: 0n })
        await ds.getRepository(HostingReservationEntity).update({ id: value.call.id }, { day: originalDay })
        await ledger.markUncertain(value.callFence)
        expect((await ledger.claimManagedCall({ actor: value.actor, reservationId: value.call.id })).claimed).toBe(false)
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: originalDay })).reserved).toBe(100n)
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { validUntil: new Date(0) })
        await ds.getRepository(UserEntity).update({ id: value.userId }, { status: UserStatus.INACTIVE })
        await ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 25n })
        await ledger.finishExecution(value.fence)
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: originalDay })).consumed).toBe(25n)
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: value.call.day ?? '' })).consumed).toBe(0n)
    })
    it('releases unsent reservations once and expired queued execution never starts', async () => {
        const value = await tenant()
        const reservation = await ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: 'queue', payer: 'managed' })
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { validUntil: new Date(0) })
        expect((await ledger.claimExecution({ actor: value.actor, reservationId: reservation.id })).claimed).toBe(false)
        await ledger.releaseUnsent({ actor: value.actor, reservationId: reservation.id })
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId })
        expect([grant.reserved, grant.consumed]).toEqual([0n, 0n])
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('checks database time after waiting for account locks', async () => {
        const value = await tenant()
        const runner = ds.createQueryRunner()
        await runner.startTransaction()
        let pending: Promise<unknown> | undefined
        try {
            await runner.manager.getRepository(HostingAccountEntity).findOne({ where: { id: value.platformId }, lock: { mode: 'pessimistic_write' } })
            pending = ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: 'waited', payer: 'byok' })
            const outcome = expect(pending).rejects.toThrow('HOSTING_ENTITLEMENT_EXPIRED')
            await runner.manager.getRepository(HostingAccountEntity).update({ id: value.platformId }, { validUntil: new Date(0) })
            await runner.commitTransaction()
            await outcome
        }
        finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release()
        }
    })
    it('enforces the last managed grant unit and rejects conflicting call retries', async () => {
        const value = await running()
        await ds.getRepository(HostingGrantEntity).update({ platformId: value.platformId, meter: 'managed_ai' }, { amount: 100n })
        const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: `grant:${i}`, maxCostMicroUsd: 100n })))
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const call = await ds.getRepository(HostingReservationEntity).findOneByOrFail({ platformId: value.platformId, kind: 'managed_ai' })
        expect((await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: call.key, maxCostMicroUsd: 100n })).id).toBe(call.id)
        await expect(ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: call.key, maxCostMicroUsd: 101n })).rejects.toThrow('HOSTING_IDEMPOTENCY_CONFLICT')
    })
    it('releases an unsent managed call once under concurrent cancellation', async () => {
        const value = await running()
        const call = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'unsent', maxCostMicroUsd: 100n })
        await Promise.all(Array.from({ length: 6 }, () => ledger.releaseUnsent({ actor: value.actor, reservationId: call.id })))
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: call.grantId })).reserved).toBe(0n)
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: call.day ?? '' })).reserved).toBe(0n)
        expect(await ds.getRepository(HostingLedgerEntity).countBy({ reservationId: call.id, operation: 'release' })).toBe(1)
        expect((await ledger.claimManagedCall({ actor: value.actor, reservationId: call.id })).claimed).toBe(false)
    })
    it('does not start an expired call and a trusted reconciler can cancel after member removal', async () => {
        const value = await running()
        const call = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'stale', maxCostMicroUsd: 100n })
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { validUntil: new Date(0) })
        expect((await ledger.claimManagedCall({ actor: value.actor, reservationId: call.id })).claimed).toBe(false)
        await ledger.finishExecution(value.fence)
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { validUntil: new Date(Date.now() + 86400000) })
        const queued = await ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: 'cancel-removed', payer: 'byok' })
        await ds.getRepository(UserEntity).update({ id: value.userId }, { status: UserStatus.INACTIVE })
        await ledger.cancelUnsent({ platformId: value.platformId, reservationId: queued.id })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('keeps a running execution tied to its original grant period', async () => {
        const value = await running()
        const original = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: value.root.grantId })
        await ds.getRepository(HostingGrantEntity).update({ id: original.id }, { validUntil: new Date(Date.now() - 1) })
        await ds.getRepository(HostingGrantEntity).insert({ id: apId(), platformId: value.platformId, sourceKey: 'new-period', meter: 'managed_ai', amount: 1000000n, consumed: 0n, reserved: 0n, validFrom: new Date(), validUntil: new Date(Date.now() + 86400000) })
        await expect(ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'new-period', maxCostMicroUsd: 100n })).rejects.toThrow('HOSTING_GRANT_EXPIRED')
    })
    it('serializes duplicate settlements and rejects cross-tenant completion fences', async () => {
        const value = await managed()
        const other = await tenant()
        await expect(ledger.settleManagedCall({ ...value.callFence, platformId: other.platformId, actualCostMicroUsd: 40n })).rejects.toThrow('HOSTING_RESERVATION_NOT_FOUND')
        await Promise.all(Array.from({ length: 8 }, () => ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 40n })))
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: value.call.grantId })).consumed).toBe(40n)
    })
    it('rolls back settlement and release when their ledger entries fail', async () => {
        const value = await managed()
        await ds.query('ALTER TABLE hosting_ledger ADD CONSTRAINT test_reject_settle CHECK (false) NOT VALID')
        try {
            await expect(ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 40n })).rejects.toThrow()
        }
        finally {
            await ds.query('ALTER TABLE hosting_ledger DROP CONSTRAINT test_reject_settle')
        }
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: value.call.grantId })).reserved).toBe(100n)
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: value.call.id })).state).toBe('running')
        await ledger.settleManagedCall({ ...value.callFence, actualCostMicroUsd: 0n })
        const unsent = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'rollback-release', maxCostMicroUsd: 50n })
        await ds.query('ALTER TABLE hosting_ledger ADD CONSTRAINT test_reject_release CHECK (false) NOT VALID')
        try {
            await expect(ledger.releaseUnsent({ actor: value.actor, reservationId: unsent.id })).rejects.toThrow()
        }
        finally {
            await ds.query('ALTER TABLE hosting_ledger DROP CONSTRAINT test_reject_release')
        }
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: unsent.grantId })).reserved).toBe(50n)
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: unsent.id })).state).toBe('reserved')
    })
    it('enforces ledger immutability in PostgreSQL', async () => {
        const value = await tenant()
        const entry = await ds.getRepository(HostingLedgerEntity).findOneByOrFail({ platformId: value.platformId })
        await expect(ds.getRepository(HostingLedgerEntity).update({ id: entry.id }, { amount: 0n })).rejects.toThrow('HOSTING_LEDGER_IMMUTABLE')
        await expect(ds.getRepository(HostingLedgerEntity).delete({ id: entry.id })).rejects.toThrow('HOSTING_LEDGER_IMMUTABLE')
    })
    it('enforces concurrency even with abundant execution credits', async () => {
        const value = await tenant()
        const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: `slot:${i}`, payer: 'byok' })))
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        for (const result of outcomes) if (result.status === 'rejected') expect(String(result.reason)).toContain('HOSTING_CONCURRENCY_LIMIT')
    })
    it('enforces last execution credit with spare concurrency', async () => {
        const value = await tenant()
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { planId: 'team', status: 'active' })
        await ds.getRepository(HostingGrantEntity).update({ platformId: value.platformId }, { sourceKey: 'stripe:synthetic-team-period' })
        await ds.getRepository(HostingGrantEntity).update({ platformId: value.platformId, meter: 'execution' }, { amount: 1n })
        const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: `credit:${i}`, payer: 'managed' })))
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        for (const result of outcomes) if (result.status === 'rejected') expect(String(result.reason)).toContain('HOSTING_CREDITS_EXHAUSTED')
    })
    it('shares the operator cap across independent tenant locks', async () => {
        const tenants = await Promise.all([running(), running(), running(), running()])
        const today = new Date().toISOString().slice(0, 10)
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: today, reserved: 0n, consumed: 0n, limit: 100n })
        const outcomes = await Promise.allSettled(tenants.map(value => ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'shared-cap', maxCostMicroUsd: 100n })))
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        for (const result of outcomes) if (result.status === 'rejected') expect(String(result.reason)).toContain('HOSTING_OPERATOR_BUDGET_EXHAUSTED')
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: today })).reserved).toBe(100n)
    })
    it('rechecks the execution grant at managed dispatch, after reservation', async () => {
        const value = await running()
        const call = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'period-expired', maxCostMicroUsd: 100n })
        await ds.getRepository(HostingGrantEntity).update({ id: value.root.grantId }, { validUntil: new Date(Date.now() - 1) })
        expect((await ledger.claimManagedCall({ actor: value.actor, reservationId: call.id })).claimed).toBe(false)
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: call.id })).state).toBe('released')
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: call.grantId })).reserved).toBe(0n)
    })
    it('releases old-day unsent calls and requires fresh reservation on the current day', async () => {
        const value = await running()
        const call = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'old-day', maxCostMicroUsd: 100n })
        await ds.getRepository(HostingDailyBudgetEntity).insert({ id: '2000-01-01', reserved: 100n, consumed: 0n, limit: 100n })
        await ds.getRepository(HostingDailyBudgetEntity).update({ id: call.day ?? '' }, { reserved: 0n })
        await ds.getRepository(HostingReservationEntity).update({ id: call.id }, { day: '2000-01-01' })
        expect((await ledger.claimManagedCall({ actor: value.actor, reservationId: call.id })).claimed).toBe(false)
        expect((await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'old-day', maxCostMicroUsd: 100n })).state).toBe('released')
        expect((await ds.getRepository(HostingDailyBudgetEntity).findOneByOrFail({ id: '2000-01-01' })).reserved).toBe(0n)
        const fresh = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: value.root.id, key: 'new-day', maxCostMicroUsd: 100n })
        expect(fresh.day).toBe(call.day)
        expect((await ledger.claimManagedCall({ actor: value.actor, reservationId: fresh.id })).claimed).toBe(true)
    })
    it('rolls back balance/slot changes if immutable ledger insertion fails', async () => {
        const value = await tenant()
        await ds.query('ALTER TABLE hosting_ledger ADD CONSTRAINT test_reject_entry CHECK (false) NOT VALID')
        try {
            await expect(ledger.reserveExecution({ actor: value.actor, projectId: value.projectId, key: 'atomic', payer: 'managed' })).rejects.toThrow()
        }
        finally {
            await ds.query('ALTER TABLE hosting_ledger DROP CONSTRAINT test_reject_entry')
        }
        expect(await ds.getRepository(HostingReservationEntity).count()).toBe(0)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).reserved).toBe(0n)
    })
})

describe('additive hosting migration', () => {
    it('rolls back empty tables without modifying self-hosted records and can reapply', async () => {
        const identityId = await identity()
        const runner = ds.createQueryRunner()
        const additions = getMigrations().slice(2)
        try {
            await runner.startTransaction()
            for (const Migration of [...additions].reverse()) await new Migration().down(runner)
            for (const Migration of additions) await new Migration().up(runner)
            await runner.commitTransaction()
        }
        finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release()
        }
        expect(await ds.getRepository(UserIdentityEntity).existsBy({ id: identityId })).toBe(true)
        expect(await ds.getRepository(FlagEntity).existsBy({ id: INSTALLATION_MODE_FLAG_ID })).toBe(true)
    })
    it('refuses rollback that would erase financial or eligibility evidence', async () => {
        const value = await tenant()
        const runner = ds.createQueryRunner()
        try {
            await runner.startTransaction(); await expect(migration.down(runner)).rejects.toThrow('HOSTING_ROLLBACK_REQUIRES_EMPTY_TABLES'); await runner.rollbackTransaction()
        }
        finally {
            await runner.release()
        }
        expect(await ds.getRepository(HostingAccountEntity).existsBy({ id: value.platformId })).toBe(true)
        expect(await ds.getRepository(HostingEligibilityEntity).count()).toBe(1)
    })
})
