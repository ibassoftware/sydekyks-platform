import { apId } from '@activepieces/core-utils'
import { DataSource, Like } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { createHostedCreditAllowance } from '../../src/app/hosting/hosting-credit-allowance'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { hostedOperatorCreditPeriod, initializeHostedOperatorCredits } from '../../src/app/hosting/hosting-operator-credits'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { readHostedCredits } from '../../src/app/hosting/hosting-usage'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, actor: HostingActor, projectId: string
const onboarding = () => createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-operator-credit-secret-at-least32characters' })
const grant = () => ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, sourceKey: Like('operator:%'), meter: 'execution' })
async function balance() {
    return tx.run({ dataSource: ds, fn: async manager => readHostedCredits(manager, await tx.account({ manager, platformId: actor.platformId }), await tx.now(manager)) })
}
beforeAll(async () => { ds = await migratedHostedPGlite() })
afterAll(async () => { if (ds?.isInitialized) await ds.destroy() })
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Operator', lastName: 'Fixture', tokenVersion: 'initial' })
    const home = await bootstrapHostedOperator(ds, onboarding(), identityId)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', identityId)
    actor = { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }; projectId = home.projectId!
})

describe('internal platform-admin monthly Credits', () => {
    it('enrolls only the verified operator home, preserving ordinary client trials and historical ledger', async () => {
        const clientId = apId()
        await ds.getRepository(UserIdentityEntity).insert({ id: clientId, email: `${clientId}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Client', lastName: 'Fixture', tokenVersion: 'initial' })
        const client = await onboarding().provision({ identityId: clientId, name: 'Ordinary client', operator: actor })
        const old = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: actor.platformId, meter: 'execution' })
        await ds.getRepository(HostingGrantEntity).update(old.id, { consumed: 7n, reserved: 2n })
        const entries = await ds.getRepository(HostingLedgerEntity).count()
        await initializeHostedOperatorCredits(ds)
        await initializeHostedOperatorCredits(ds)
        expect((await balance()).execution).toMatchObject({ amount: '100000', available: '100000' })
        expect(await ds.getRepository(HostingLedgerEntity).count()).toBe(entries + 2)
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: old.id })).toMatchObject({ consumed: 7n, reserved: 2n })
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })).toMatchObject({ planId: 'trial', status: 'trialing' })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: client.platformId, meter: 'execution' })).toMatchObject({ amount: 1000n })
        const allowance = await createHostedCreditAllowance({ dataSource: ds }).read({ actor, platformId: actor.platformId })
        expect(allowance).toMatchObject({ fixed: true, effectiveMonthlyCredits: 100000, period: { amount: '100000' } })
    })
    it('keeps usage and reservations across repeated reads and retains the same BYOK execution accounting', async () => {
        await initializeHostedOperatorCredits(ds)
        const ledger = createHostedLedger({ dataSource: ds })
        const root = await ledger.reserveExecution({ actor, projectId, key: 'operator-byok', payer: 'byok' })
        expect((await balance()).execution).toMatchObject({ amount: '100000', reserved: '1', available: '99999' })
        const claimed = await ledger.claimExecution({ actor, reservationId: root.id })
        await ledger.finishExecution({ platformId: actor.platformId, reservationId: root.id, dispatchId: claimed.dispatchId! })
        await initializeHostedOperatorCredits(ds)
        expect((await balance()).execution).toMatchObject({ consumed: '1', reserved: '0', available: '99999' })
        await expect(createHostedCreditAllowance({ dataSource: ds }).save({ actor, input: { platformId: actor.platformId, expectedRevision: 0, requestKey: 'operator-change', monthlyCredits: 200000, reason: 'Synthetic test' } })).rejects.toThrow('HOSTING_CREDIT_ALLOWANCE_FIXED_ENTITLEMENT')
    })
    it('can finish work already dispatched against the trial without refunding or moving its charge', async () => {
        const ledger = createHostedLedger({ dataSource: ds })
        const root = await ledger.reserveExecution({ actor, projectId, key: 'pre-enrollment', payer: 'byok' })
        const claimed = await ledger.claimExecution({ actor, reservationId: root.id })
        await initializeHostedOperatorCredits(ds)
        await ledger.finishExecution({ platformId: actor.platformId, reservationId: root.id, dispatchId: claimed.dispatchId! })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: root.grantId })).toMatchObject({ consumed: 1n, reserved: 0n })
        expect((await balance()).execution).toMatchObject({ consumed: '0', available: '100000' })
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ activeExecutions: 0 })
    })
    it('issues one current monthly grant after inactivity without accruing missed months or resetting old usage', async () => {
        const anchor = new Date(); anchor.setUTCMonth(anchor.getUTCMonth() - 2)
        await ds.getRepository(HostingAccountEntity).update(actor.platformId, { trialStartedAt: anchor })
        await initializeHostedOperatorCredits(ds)
        const current = await grant(), previousFrom = new Date(current.validFrom), previousUntil = new Date(current.validUntil)
        previousFrom.setUTCMonth(previousFrom.getUTCMonth() - 1); previousUntil.setUTCMonth(previousUntil.getUTCMonth() - 1)
        const oldKey = `operator:${actor.identityId}:${previousFrom.toISOString()}`
        await ds.getRepository(HostingGrantEntity).update({ platformId: actor.platformId, sourceKey: current.sourceKey }, { sourceKey: oldKey, validFrom: previousFrom, validUntil: previousUntil })
        await ds.getRepository(HostingGrantEntity).update(current.id, { consumed: 10n, reserved: 2n })
        await ds.getRepository(HostingAccountEntity).update(actor.platformId, { validUntil: previousUntil })
        expect((await balance()).execution).toMatchObject({ amount: '100000', available: '100000' })
        await balance()
        expect(await ds.getRepository(HostingGrantEntity).countBy({ platformId: actor.platformId, sourceKey: Like('operator:%'), meter: 'execution' })).toBe(2)
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: current.id })).toMatchObject({ consumed: 10n, reserved: 2n })
    })
    it('does not clear a suspension or refill after operator authorization is removed', async () => {
        await initializeHostedOperatorCredits(ds)
        vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '')
        expect((await balance()).execution.available).toBe('0')
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ status: 'suspended' })
        vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', actor.identityId)
        await initializeHostedOperatorCredits(ds)
        expect((await balance()).execution.available).toBe('0')
    })
    it('does not enroll an unverified operator or turn a suspended trial into active access', async () => {
        await ds.getRepository(UserIdentityEntity).update(actor.identityId, { verified: false })
        await initializeHostedOperatorCredits(ds)
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })).toMatchObject({ planId: 'trial' })
        await ds.getRepository(UserIdentityEntity).update(actor.identityId, { verified: true })
        await ds.getRepository(HostingAccountEntity).update(actor.platformId, { status: 'suspended' })
        await initializeHostedOperatorCredits(ds)
        expect(await ds.getRepository(HostingGrantEntity).countBy({ platformId: actor.platformId, sourceKey: Like('operator:%') })).toBe(0)
    })
    it('clamps monthly anniversaries without drifting after February', () => {
        const anchor = new Date('2026-01-31T08:30:00Z')
        expect(hostedOperatorCreditPeriod(anchor, new Date('2026-03-01T00:00:00Z'))).toEqual({ from: new Date('2026-02-28T08:30:00Z'), until: new Date('2026-03-31T08:30:00Z') })
    })
})
