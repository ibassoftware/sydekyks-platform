import { randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { PlatformRole } from '@activepieces/shared'
import Fastify from 'fastify'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../../../src/app/authentication/user-identity/user-identity-entity'
import { commonProperties } from '../../../../src/app/database/database-connection'
import { getMigrations } from '../../../../src/app/database/postgres-connection'
import { FlagEntity } from '../../../../src/app/flags/flag.entity'
import { HostingAccountEntity, HostingGrantEntity, HostingInvitationEntity, HostingLedgerEntity, HostingReservationEntity } from '../../../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../../../src/app/hosting/hosting-onboarding'
import { HostingStripePeriodEntity } from '../../../../src/app/hosting/hosting-stripe-entities'
import { HostingSubscriptionCommandEntity, HostingSubscriptionEntity } from '../../../../src/app/hosting/hosting-subscription-entities'
import { createHostedSubscriptions } from '../../../../src/app/hosting/hosting-subscriptions'
import { createHostedTenantMembers } from '../../../../src/app/hosting/hosting-tenant-members'
import { HostingActor } from '../../../../src/app/hosting/hosting-transactions'
import { fundedCore, positionCoreAfterEnd, subscriptionIdentity, subscriptionOperator } from '../../../helpers/hosting-subscription-fixtures'

if (!process.env['HOSTING_TEST_POSTGRES_PORT']) throw new Error('Set explicit HOSTING_TEST_POSTGRES_PORT for the disposable CI database')
const schema = `hosting_subscription_${randomBytes(6).toString('hex')}`
const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(process.env['HOSTING_TEST_POSTGRES_PORT']), username: process.env['HOSTING_TEST_POSTGRES_USER'] ?? 'sydekyks_ci', password: process.env['HOSTING_TEST_POSTGRES_PASSWORD'] ?? 'disposable-ci-only', database: process.env['HOSTING_TEST_POSTGRES_DATABASE'] ?? 'sydekyks_ci', schema, extra: { options: `-c search_path=${schema},public` }, migrations: getMigrations(), ...commonProperties })
let actor: HostingActor, client: Awaited<ReturnType<typeof fundedCore>>
const ledger = createHostedLedger({ dataSource: ds }), subscriptions = createHostedSubscriptions({ dataSource: ds })
const setDue = (date: Date, expectedRevision = 0, requestKey = apId()) => subscriptions.update({ actor, input: { platformId: client.platformId, expectedRevision, requestKey, renewalDueAt: date.toISOString(), reason: 'Synthetic PostgreSQL boundary fixture' } })
async function holdAccount() {
    const runner = ds.createQueryRunner(); await runner.connect(); await runner.startTransaction()
    await runner.query('SELECT id FROM hosting_account WHERE id=$1 FOR UPDATE', [client.platformId])
    return async () => {
        try {
            await runner.commitTransaction() 
        }
        finally {
            await runner.release() 
        } 
    }
}
beforeAll(async () => {
    await ds.initialize(); await ds.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
    const runner = ds.createQueryRunner()
    try {
        await runner.createSchema(schema, true) 
    }
    finally {
        await runner.release() 
    }
    await ds.runMigrations({ transaction: 'each' })
})
afterAll(async () => {
    if (ds.isInitialized) {
        await ds.query(`DROP SCHEMA "${schema}" CASCADE`); await ds.destroy() 
    } 
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${schema}"."${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    actor = await subscriptionOperator(ds); vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', actor.identityId)
    client = await fundedCore(ds, actor)
})
describe('PostgreSQL manual subscription fencing', () => {
    it('serializes an overdue command against admission and never dispatches the losing reservation', async () => {
        const unlock = await holdAccount()
        let completed = 0
        const update = setDue(new Date(Date.now() - 16 * 86_400_000)).finally(() => {
            completed++ 
        })
        const reserve = ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'concurrent-admission', payer: 'byok' }).then(value => ({ value }), error => ({ error })).finally(() => {
            completed++ 
        })
        try {
            await new Promise(resolve => setTimeout(resolve, 30)); expect(completed).toBe(0) 
        }
        finally {
            await unlock() 
        }
        await update
        const outcome = await reserve
        if ('value' in outcome) expect((await ledger.claimExecution({ actor: client.actor, reservationId: outcome.value.id })).claimed).toBe(false)
        else expect(String(outcome.error)).toContain('ENTITLEMENT_EXPIRED')
        expect(await ds.getRepository(HostingReservationEntity).existsBy({ platformId: client.platformId, state: 'running' })).toBe(false)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })).activeExecutions).toBe(0)
    })
    it('permits one concurrent revision and one audit command without changing financial grant amounts', async () => {
        const before = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        const results = await Promise.allSettled([setDue(new Date(Date.now() + 86400000)), setDue(new Date(Date.now() + 2 * 86400000))])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
        expect(await ds.getRepository(HostingSubscriptionCommandEntity).count()).toBe(1)
        const after = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        expect(after).toEqual(before)
    })
    it('reads the database clock after a blocked account lock at the exact fifteen-day cutoff', async () => {
        await setDue(new Date(Date.now() - 15 * 86_400_000 + 200))
        const unlock = await holdAccount()
        const reserve = ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'cross-cutoff-while-waiting', payer: 'managed' }).then(value => ({ value }), error => ({ error }))
        try {
            await new Promise(resolve => setTimeout(resolve, 260)) 
        }
        finally {
            await unlock() 
        }
        const result = await reserve
        expect('error' in result).toBe(true)
        if ('error' in result) expect(String(result.error)).toContain('ENTITLEMENT_EXPIRED')
        expect(await ds.getRepository(HostingReservationEntity).count()).toBe(0)
    })
    it('uses only the final Core period in grace under actual PostgreSQL row locks', async () => {
        await positionCoreAfterEnd(ds, client.platformId)
        const policy = await setDue(new Date(Date.now() - 86400000))
        const root = await ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'pg-core-grace', payer: 'managed' })
        expect(root.grantId).toBe(policy.boundPeriod!.executionGrantId)
        const claim = await ledger.claimExecution({ actor: client.actor, reservationId: root.id })
        const call = await ledger.reserveManagedCall({ actor: client.actor, rootReservationId: root.id, key: 'pg-core-managed-grace', maxCostMicroUsd: 10n })
        expect(call.grantId).toBe(policy.boundPeriod!.managedAiGrantId)
        const sent = await ledger.claimManagedCall({ actor: client.actor, reservationId: call.id })
        await ledger.settleManagedCall({ platformId: client.platformId, reservationId: call.id, dispatchId: sent.dispatchId!, actualCostMicroUsd: 5n })
        await ledger.finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: claim.dispatchId! })
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId })).consumed).toBe(1n)
    })
    it('binds an existing funded Starter period and rejects silent migration to a new paid period', async () => {
        // Explicit synthetic funding rows test serialization only, not payment processing.
        const now = Date.now(), start = new Date(now - 31 * 86400000), end = new Date(now - 86400000), sourceKey = `stripe:synthetic:${apId()}`, periodId = apId()
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'starter', validUntil: end })
        await ds.getRepository(HostingStripePeriodEntity).insert({ id: periodId, platformId: client.platformId, stripeAccountId: 'synthetic-account', customerId: 'synthetic-customer', subscriptionId: 'synthetic-subscription', itemId: 'synthetic-item', priceId: 'synthetic-price', planId: 'starter', sourceKey, periodStart: start, periodEnd: end, invoiceIds: ['synthetic-invoice'], lineIds: ['synthetic-line'], chargeIds: ['synthetic-charge'], revokedAt: null })
        for (const [meter, amount] of [['execution', 2000n], ['managed_ai', 5000000n]] as const) {
            const id = apId()
            await ds.getRepository(HostingGrantEntity).insert({ id, platformId: client.platformId, sourceKey, meter, amount, reserved: 0n, consumed: 0n, validFrom: start, validUntil: end })
            await ds.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: client.platformId, grantId: id, reservationId: null, operation: 'grant', key: `grant:${id}`, amount })
        }
        const baselineLedger = await ds.getRepository(HostingLedgerEntity).count()
        const defaultPolicy = await subscriptions.read({ actor, platformId: client.platformId })
        expect(defaultPolicy).toMatchObject({ origin: 'paid_default', state: 'grace', revision: 0, renewalDueAt: end.toISOString() })
        expect(await ds.getRepository(HostingSubscriptionEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(baselineLedger)
        // The reachable tenant-members wrapper must not inherit the legacy
        // invitation helper's already-expired raw paid-period deadline.
        vi.stubEnv('AP_FRONTEND_URL', 'https://synthetic-subscription.test.invalid')
        const inviteeId = await subscriptionIdentity(ds), invitee = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: inviteeId })
        const app = Fastify()
        try {
            const members = createHostedTenantMembers({ dataSource: ds, onboarding: createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-subscription-fixture-secret-atleast32characters' }), log: app.log })
            const current = await members.list({ actor: client.actor })
            const invited = await members.command({ actor: client.actor, action: 'invite', input: { email: invitee.email, role: PlatformRole.MEMBER, expectedRevision: current.revision, expectedState: current.stateHash, requestKey: apId() } })
            expect(invited.setupUrl).toBeTruthy()
            const invitation = await ds.getRepository(HostingInvitationEntity).findOneByOrFail({ platformId: client.platformId, status: 'pending' })
            expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now())
            expect(invitation.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000)
            expect(invitation.expiresAt.getTime()).toBeLessThanOrEqual(Date.parse(defaultPolicy.graceEndsAt!))
        }
        finally {
            await app.close()
        }

        const root = await ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'pg-starter-default-grace', payer: 'byok' })
        expect(root.grantId).toBe(defaultPolicy.boundPeriod!.executionGrantId)
        const claimed = await ledger.claimExecution({ actor: client.actor, reservationId: root.id })
        await ledger.finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: claimed.dispatchId! })
        await setDue(end)
        const reset = await subscriptions.update({ actor, input: { platformId: client.platformId, expectedRevision: 1, requestKey: apId(), renewalDueAt: null, reason: 'Restore funded paid default' } })
        expect(reset).toMatchObject({ origin: 'paid_default', state: 'grace', revision: 2, renewalDueAt: end.toISOString() })
        await setDue(end, 2)
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { validUntil: new Date(now + 30 * 86400000) })
        expect((await subscriptions.read({ actor, platformId: client.platformId })).state).toBe('review_required')
        await expect(ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'no-policy-transfer', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
    })
})
