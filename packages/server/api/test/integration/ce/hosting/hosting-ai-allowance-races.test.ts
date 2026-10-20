import { randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../../../src/app/authentication/user-identity/user-identity-entity'
import { commonProperties } from '../../../../src/app/database/database-connection'
import { getMigrations } from '../../../../src/app/database/postgres-connection'
import { FlagEntity } from '../../../../src/app/flags/flag.entity'
import { createHostedCreditAllowance } from '../../../../src/app/hosting/hosting-credit-allowance'
import { HostingCreditAllowanceChangeEntity } from '../../../../src/app/hosting/hosting-credit-allowance-entities'
import { HostingGrantEntity } from '../../../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../../../src/app/hosting/hosting-onboarding'
import { createHostedTraining } from '../../../../src/app/hosting/hosting-training'
import { HostingActor, hostingTransactions } from '../../../../src/app/hosting/hosting-transactions'
import { foundingCourseDraft } from '../../../../src/app/lms/lms-content'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../../../../src/app/lms/lms-entities'
import { bootstrapHostedOperator } from '../../../helpers/hosting-fixtures'

if (!process.env['HOSTING_TEST_POSTGRES_PORT']) throw new Error('Set explicit HOSTING_TEST_POSTGRES_PORT for the disposable CI database')
const schema = `hosting_allowance_${randomBytes(6).toString('hex')}`
const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(process.env['HOSTING_TEST_POSTGRES_PORT']), username: process.env['HOSTING_TEST_POSTGRES_USER'] ?? 'sydekyks_ci', password: process.env['HOSTING_TEST_POSTGRES_PASSWORD'] ?? 'disposable-ci-only', database: process.env['HOSTING_TEST_POSTGRES_DATABASE'] ?? 'sydekyks_ci', schema, extra: { options: `-c search_path=${schema},public` }, migrations: getMigrations(), ...commonProperties })
let actor: HostingActor, client: Awaited<ReturnType<typeof makeClient>>
const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-allowance-race-subject-at-least32characters' })
const allowance = createHostedCreditAllowance({ dataSource: ds }), ledger = createHostedLedger({ dataSource: ds }), training = createHostedTraining({ dataSource: ds })
async function identity() {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@test.invalid`, verified: true, provider: 'EMAIL', password: 'unused', firstName: 'Race', lastName: 'Fixture', tokenVersion: 'initial' })
    return id
}
async function makeClient() {
    const identityId = await identity(), tenant = await onboarding.provision({ identityId, name: 'Race client', operator: actor })
    return { ...tenant, identityId, actor: { identityId, platformId: tenant.platformId, tokenVersion: tenant.tokenVersion } }
}
async function activate() {
    const enrollmentId = apId(), courseId = apId(), receiptId = apId(), now = await hostingTransactions.now(ds.manager)
    await ds.getRepository(LmsCourseEntity).insert({ id: courseId, slug: `synthetic-${courseId}`, ownerPlatformId: null, audience: 'partner', certificationMode: 'partner', revision: 1, status: 'published', content: foundingCourseDraft, reviewedBy: actor.identityId, reviewedAt: now })
    await ds.getRepository(LmsEnrollmentEntity).insert({ id: enrollmentId, courseId, identityId: client.identityId, grantPlatformId: null, accessType: 'partner_training', package: 'core', paymentReference: receiptId, workspacePlatformId: client.platformId, startsAt: now, accessUntil: new Date(now.getTime() + 365 * 86400000), assessmentUntil: new Date(now.getTime() + 90 * 86400000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: actor.identityId })
    await training.activate({ actor, platformId: client.platformId, identityId: client.identityId, enrollmentId, receiptId, tier: 'core' })
    return enrollmentId
}
async function root() {
    const reservation = await ledger.reserveExecution({ actor: client.actor, projectId: client.projectId!, key: apId(), payer: 'managed' })
    const claim = await ledger.claimExecution({ actor: client.actor, reservationId: reservation.id })
    return { reservation, dispatchId: claim.dispatchId! }
}
async function holdAccount() {
    const runner = ds.createQueryRunner()
    await runner.connect(); await runner.startTransaction()
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
    await ds.initialize()
    await ds.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
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
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${schema}"."${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const id = await identity(), home = await bootstrapHostedOperator(ds, onboarding, id)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', id)
    actor = { identityId: id, platformId: home.platformId, tokenVersion: home.tokenVersion }
    client = await makeClient()
})

describe('PostgreSQL allowance serialization', () => {
    it('serializes allowance reduction against an AI reservation without erasing committed Credits', async () => {
        await activate()
        const execution = await root(), unlock = await holdAccount()
        let completed = 0
        const cap = allowance.save({ actor, input: { platformId: client.platformId, expectedRevision: 0, requestKey: 'race:cap', monthlyCredits: 1, reason: 'Reduce to the committed base run' } }).finally(() => {
            completed++
        })
        const reserve = ledger.reserveManagedCall({ actor: client.actor, rootReservationId: execution.reservation.id, key: 'race:reservation', maxCostMicroUsd: 1000n }).finally(() => {
            completed++
        })
        try {
            await new Promise(resolve => setTimeout(resolve, 30))
            expect(completed).toBe(0)
        }
        finally {
            await unlock()
        }
        const [saved, held] = await Promise.allSettled([cap, reserve])
        if (saved.status === 'rejected') expect(String(saved.reason)).toContain('BELOW_COMMITTED')
        if (held.status === 'fulfilled') {
            const claim = await ledger.claimManagedCall({ actor: client.actor, reservationId: held.value.id })
            expect(claim.claimed).toBe(true)
            await ledger.settleManagedCall({ platformId: client.platformId, reservationId: held.value.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 500n })
        }
        else expect(String(held.reason)).toContain('CREDITS_EXHAUSTED')
        const view = await allowance.read({ actor, platformId: client.platformId })
        expect(view.period).toMatchObject({ amount: saved.status === 'fulfilled' ? '1' : '10000', reserved: '0', consumed: held.status === 'fulfilled' ? '3' : '1', available: held.status === 'fulfilled' ? '9997' : '0' })
        expect([saved, held].filter(result => result.status === 'fulfilled')).toHaveLength(1)
        await ledger.finishExecution({ platformId: client.platformId, reservationId: execution.reservation.id, dispatchId: execution.dispatchId })
    })
    it('serializes receipt revocation against allowance changes without reviving grants or losing held calls', async () => {
        const enrollmentId = await activate(), execution = await root()
        const held = await ledger.reserveManagedCall({ actor: client.actor, rootReservationId: execution.reservation.id, key: 'held', maxCostMicroUsd: 5000n }), claim = await ledger.claimManagedCall({ actor: client.actor, reservationId: held.id })
        const unlock = await holdAccount()
        const cap = allowance.save({ actor, input: { platformId: client.platformId, expectedRevision: 0, requestKey: 'race:refund-cap', monthlyCredits: 7000, reason: 'Synthetic agreed allowance' } })
        const refund = training.revoke({ actor, enrollmentId })
        await unlock()
        const results = await Promise.allSettled([cap, refund])
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
        const trainingGrants = (await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId, meter: 'execution' })).filter(grant => grant.sourceKey.startsWith('training:'))
        expect(trainingGrants.every(grant => grant.revokedAt !== null)).toBe(true)
        expect((await allowance.read({ actor, platformId: client.platformId })).period).toBeNull()
        await ledger.settleManagedCall({ platformId: client.platformId, reservationId: held.id, dispatchId: claim.dispatchId!, actualCostMicroUsd: 1000n })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: held.grantId })).toMatchObject({ consumed: 5n, reserved: 0n, revokedAt: expect.any(Date) })
        await ledger.finishExecution({ platformId: client.platformId, reservationId: execution.reservation.id, dispatchId: execution.dispatchId })
    })
    it('rechecks operator credentials after waiting for a target account lock', async () => {
        await activate()
        const before = await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })
        const unlock = await holdAccount()
        const pending = allowance.save({ actor, input: { platformId: client.platformId, expectedRevision: 0, requestKey: 'race:revoked-operator', monthlyCredits: 8000, reason: 'Synthetic revoke while blocked' } })
        await new Promise(resolve => setTimeout(resolve, 30))
        await ds.getRepository(UserIdentityEntity).update({ id: actor.identityId }, { tokenVersion: 'revoked-while-waiting' })
        await unlock()
        await expect(pending).rejects.toThrow('OPERATOR_REQUIRED')
        expect(await ds.getRepository(HostingCreditAllowanceChangeEntity).count()).toBe(0)
        expect(await ds.getRepository(HostingGrantEntity).findBy({ platformId: client.platformId })).toEqual(before)
    })
    it('rolls back one of two different clients using the same actor/request key concurrently', async () => {
        await activate()
        const original = client, other = await makeClient(), createRunner = ds.createQueryRunner.bind(ds)
        client = other; await activate(); client = original
        let arrived = 0, release!: () => void
        const gate = new Promise<void>(resolve => {
            release = resolve
        })
        // Synchronize only the two SQL inserts after real auth/revision checks;
        // PostgreSQL's actual unique index arbitrates the idempotency collision.
        const spy = vi.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
            const runner = createRunner(...args), query = runner.query.bind(runner)
            runner.query = async (sql, ...rest) => {
                if (/^INSERT INTO .*hosting_credit_allowance_change/.test(sql)) {
                    if (++arrived === 2) release()
                    await gate
                }
                return query(sql, ...rest)
            }
            return runner
        })
        try {
            const outcomes = await Promise.allSettled([client.platformId, other.platformId].map((platformId, i) => allowance.save({ actor, input: { platformId, expectedRevision: 0, requestKey: 'race:shared-key', monthlyCredits: 7000 + i, reason: 'Synthetic agreed allowance' } })))
            expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
            const failed = outcomes.find(value => value.status === 'rejected') as PromiseRejectedResult
            expect(String(failed.reason)).toContain('IDEMPOTENCY_CONFLICT')
            expect(await ds.getRepository(HostingCreditAllowanceChangeEntity).count()).toBe(1)
            const views = await Promise.all([client.platformId, other.platformId].map(platformId => allowance.read({ actor, platformId })))
            expect(views.map(view => view.revision).sort()).toEqual([0, 1])
            expect(views.map(view => view.period?.amount).sort()).toEqual(expect.arrayContaining(['10000']))
        }
        finally {
            release(); spy.mockRestore()
        }
    })
})
