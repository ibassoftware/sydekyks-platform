import { apId } from '@activepieces/core-utils'
import { HostedSubscriptionUpdate, PlatformRole, UserStatus } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { createHostedAccess } from '../../src/app/hosting/hosting-access'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { hasOperationalAccess } from '../../src/app/hosting/hosting-access-policy'
import { createHostedAiGateway } from '../../src/app/hosting/hosting-ai-gateway'
import { createHostedAssessment } from '../../src/app/hosting/hosting-assessment'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { HostingSubscriptionCommandEntity, HostingSubscriptionEntity } from '../../src/app/hosting/hosting-subscription-entities'
import { SUBSCRIPTION_GRACE_MS, subscriptionAccountActive, subscriptionGrantActive } from '../../src/app/hosting/hosting-subscription-policy'
import { createHostedSubscriptions } from '../../src/app/hosting/hosting-subscriptions'
import { createHostedTraining } from '../../src/app/hosting/hosting-training'
import { HostingTrainingEntity } from '../../src/app/hosting/hosting-training-entity'
import { fundedTrainingPeriods, hostingMonthAnniversary } from '../../src/app/hosting/hosting-training-periods'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { readHostedCredits } from '../../src/app/hosting/hosting-usage'
import { LmsEnrollmentEntity } from '../../src/app/lms/lms-entities'
import { UserEntity } from '../../src/app/user/user-entity'
import { migratedHostedPGlite } from '../helpers/hosting-fixtures'
import { fundedCore, positionCoreAfterEnd, subscriptionIdentity, subscriptionOperator } from '../helpers/hosting-subscription-fixtures'

let ds: DataSource, actor: HostingActor, client: Awaited<ReturnType<typeof fundedCore>>
const subscriptions = () => createHostedSubscriptions({ dataSource: ds })
const ledger = () => createHostedLedger({ dataSource: ds })
const read = () => subscriptions().read({ actor, platformId: client.platformId })
const override = (renewalDueAt: string | null, expectedRevision = 0, requestKey = apId()) => subscriptions().update({ actor, input: { platformId: client.platformId, expectedRevision, requestKey, renewalDueAt, reason: 'Synthetic manually recorded renewal date' } })
const future = () => new Date(Date.now() + 86_400_000).toISOString()
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
const snapshot = async () => JSON.stringify({ grants: await ds.getRepository(HostingGrantEntity).find({ where: { platformId: client.platformId }, order: { id: 'ASC' } }), ledger: await ds.getRepository(HostingLedgerEntity).find({ where: { platformId: client.platformId }, order: { id: 'ASC' } }), enrollment: await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: client.enrollmentId }) }, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
beforeAll(async () => {
    ds = await migratedHostedPGlite() 
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy() 
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    actor = await subscriptionOperator(ds)
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', actor.identityId)
    client = await fundedCore(ds, actor)
})

describe('explicit manual subscription dates', () => {
    it('preserves fixed Core defaults and binds the closing prepaid month without early credit use', async () => {
        const before = await snapshot(), initial = await read()
        expect(initial.state).toBe('unmanaged'); expect(initial.origin).toBe('fixed'); expect(initial.revision).toBe(0)
        const result = await override(future())
        expect(result.boundPeriod?.sourceKey).toMatch(new RegExp(`^training:${client.trainingId}:0$`))
        expect(result.graceEndsAt).toBe(new Date(Date.parse(result.renewalDueAt!) + SUBSCRIPTION_GRACE_MS).toISOString())
        expect(await snapshot()).toBe(before)
        const reservation = await ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'first-month', payer: 'byok' })
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId })
        expect(grant.sourceKey).toBe(`training:${client.trainingId}:0`)
        const loaded = await tx.run({ dataSource: ds, fn: manager => tx.account({ manager, platformId: client.platformId }) })
        const last = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: result.boundPeriod!.executionGrantId })
        expect(subscriptionGrantActive(loaded, last, new Date(last.validFrom.getTime() - 1))).toBe(false)
    })
    it.each(['legacy', 'calendar'] as const)('closes an early due date without another prepaid refill for %s training and preserves normal final-period grace', async schedule => {
        let target = client
        if (schedule === 'calendar') {
            const identityId = await subscriptionIdentity(ds), home = await createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-subscription-fixture-secret-atleast32characters' }).provision({ identityId, name: 'Calendar prepaid training fixture', operator: actor })
            const prior = await ds.getRepository(LmsEnrollmentEntity).findOneByOrFail({ id: client.enrollmentId }), now = await tx.now(ds.manager), receiptId = `synthetic-calendar:${apId()}`
            const enrollment = await ds.getRepository(LmsEnrollmentEntity).save({ ...prior, id: apId(), identityId, workspacePlatformId: home.platformId, startsAt: now, accessUntil: hostingMonthAnniversary(now, 12), assessmentUntil: new Date(now.getTime() + 90 * 86400000), paymentReference: receiptId })
            const training = await createHostedTraining({ dataSource: ds }).activate({ actor, platformId: home.platformId, identityId, enrollmentId: enrollment.id, receiptId, tier: 'core' })
            target = { ...home, identityId, actor: { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }, trainingId: training.id, enrollmentId: enrollment.id }
        }
        const training = await ds.getRepository(HostingTrainingEntity).findOneByOrFail({ id: target.trainingId }), periods = fundedTrainingPeriods(training)!
        const start = training.startsAt.getTime(), due = new Date(start + 25 * 86400000), before = await ds.getRepository(HostingGrantEntity).count()
        const setDue = (date: Date, expectedRevision: number) => subscriptions().update({ actor, input: { platformId: target.platformId, expectedRevision, requestKey: apId(), renewalDueAt: date.toISOString(), reason: 'Synthetic prepaid expiration boundary' } })
        const policy = await setDue(due, 0)
        expect(policy.boundPeriod?.sourceKey).toBe(`training:${target.trainingId}:0`)
        const first = policy.boundPeriod!.executionGrantId, clock = vi.spyOn(tx, 'now')
        try {
            for (const day of [25, 31, 39]) {
                clock.mockResolvedValue(new Date(start + day * 86400000))
                const reserve = await ledger().reserveExecution({ actor: target.actor, projectId: target.projectId!, key: `prepaid-${schedule}-day-${day}`, payer: 'byok' })
                expect(reserve.grantId).toBe(first)
                await ledger().releaseUnsent({ actor: target.actor, reservationId: reserve.id })
            }
            clock.mockResolvedValue(new Date(start + 40 * 86400000))
            await expect(ledger().reserveExecution({ actor: target.actor, projectId: target.projectId!, key: `prepaid-${schedule}-cutoff`, payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
            const anniversary = await setDue(periods[1].from, 1)
            expect(anniversary.boundPeriod?.executionGrantId).toBe(first)
            const normal = await setDue(training.endsAt, 2)
            expect(normal.boundPeriod?.sourceKey).toBe(`training:${target.trainingId}:${periods.length - 1}`)
            clock.mockResolvedValue(new Date(training.endsAt.getTime() + 86400000))
            const final = await ledger().reserveExecution({ actor: target.actor, projectId: target.projectId!, key: `prepaid-${schedule}-normal-grace`, payer: 'byok' })
            expect(final.grantId).toBe(normal.boundPeriod?.executionGrantId)
            expect(await ds.getRepository(HostingGrantEntity).count()).toBe(before)
        }
        finally {
            clock.mockRestore()
        }
    })
    it('uses only remaining final-month credits during grace and clearing restores original expiry', async () => {
        await positionCoreAfterEnd(ds, client.platformId)
        await expect(ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'default-expired', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
        const before = await snapshot(), result = await override(past(1))
        expect(result.state).toBe('grace'); expect(await snapshot()).toBe(before)
        const reserve = await ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'grace-byok', payer: 'byok' })
        expect(reserve.grantId).toBe(result.boundPeriod!.executionGrantId)
        const claim = await ledger().claimExecution({ actor: client.actor, reservationId: reserve.id })
        expect(claim.claimed).toBe(true)
        await ledger().finishExecution({ platformId: client.platformId, reservationId: reserve.id, dispatchId: claim.dispatchId! })
        const balance = await ledger().balance({ actor: client.actor })
        expect(balance.find(grant => grant.id === result.boundPeriod!.executionGrantId)?.available).toBe(999n)
        expect(balance.filter(grant => grant.sourceKey.endsWith(':0')).every(grant => grant.available === 0n)).toBe(true)
        await override(null, 1)
        await expect(ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'cleared-expired', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
    })
    it('has an exact UTC fifteen-day boundary and an earlier override caps all future grants', async () => {
        const result = await override(past(16))
        const loaded = await tx.run({ dataSource: ds, fn: manager => tx.account({ manager, platformId: client.platformId }) })
        const cutoff = Date.parse(result.graceEndsAt!)
        expect(subscriptionAccountActive(loaded, new Date(cutoff - 1))).toBe(true)
        expect(subscriptionAccountActive(loaded, new Date(cutoff))).toBe(false)
        expect((await read()).state).toBe('overdue')
        for (const payer of ['managed', 'byok'] as const) await expect(ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: `overdue-${payer}`, payer })).rejects.toThrow('ENTITLEMENT_EXPIRED')
        expect(await ds.getRepository(HostingReservationEntity).count()).toBe(0)
        const credits = await tx.run({ dataSource: ds, fn: async manager => readHostedCredits(manager, await tx.account({ manager, platformId: client.platformId }), await tx.now(manager)) })
        expect(credits.execution.available).toBe('0'); expect(credits.ai.available).toBe('0')
        await override(future(), 1)
        expect((await ledger().balance({ actor: client.actor })).find(grant => grant.sourceKey === `training:${client.trainingId}:0` && grant.meter === 'execution')?.available).toBe(1000n)
    })
    it('cancels known-unsent admission at cutoff while keeping already-sent liabilities settleable', async () => {
        const root = await ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'running', payer: 'managed' })
        const claim = await ledger().claimExecution({ actor: client.actor, reservationId: root.id })
        const call = await ledger().reserveManagedCall({ actor: client.actor, rootReservationId: root.id, key: 'already-sent', maxCostMicroUsd: 3n })
        const sent = await ledger().claimManagedCall({ actor: client.actor, reservationId: call.id })
        await override(past(16))
        await expect(ledger().reserveManagedCall({ actor: client.actor, rootReservationId: root.id, key: 'after-cutoff', maxCostMicroUsd: 1n })).rejects.toThrow('ENTITLEMENT_EXPIRED')
        await ledger().settleManagedCall({ platformId: client.platformId, reservationId: call.id, dispatchId: sent.dispatchId!, actualCostMicroUsd: 2n })
        await ledger().finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: claim.dispatchId! })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: client.platformId })).activeExecutions).toBe(0)
    })
    it('rechecks prepared managed and BYOK reservations after an overdue command', async () => {
        let revision = 0
        for (const payer of ['managed', 'byok'] as const) {
            await override(future(), revision++)
            const reservation = await ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: `prepared-${payer}`, payer })
            await override(past(16), revision++)
            expect((await ledger().claimExecution({ actor: client.actor, reservationId: reservation.id })).claimed).toBe(false)
            expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: reservation.id })).state).toBe('released')
        }
    })
    it('preserves independent suspension/refund and rejects transfer to assessment or a changed entitlement', async () => {
        const policy = await override(future())
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { billingHold: true })
        await override(future(), 1)
        await expect(ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'hold', payer: 'byok' })).rejects.toThrow('ENTITLEMENT_EXPIRED')
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { billingHold: false })
        await ds.getRepository(HostingGrantEntity).update({ id: policy.boundPeriod!.managedAiGrantId }, { revokedAt: new Date() })
        expect((await read()).state).toBe('review_required')
        await expect(override(future(), 2)).rejects.toThrow('FUNDED_ENTITLEMENT_REQUIRED')
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'assessment' })
        expect((await read()).canManage).toBe(false)
        await expect(override(future(), 2)).rejects.toThrow('FUNDED_ENTITLEMENT_REQUIRED')
    })
    it('refuses managed and BYOK provider sends from an old running root after the cutoff', async () => {
        const configId = apId()
        await ds.getRepository(AIProviderEntity).insert({ id: configId, platformId: client.platformId, provider: 'deepseek', displayName: 'Synthetic BYOK', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-never-sent-subscription-byok' }), config: {}, status: 'active', enabledForChat: true, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
        const complete = vi.fn(async () => {
            throw new Error('Provider must never be called') 
        })
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic-subscription-provider', endpoint: 'diagnostic://no-network', complete } })
        let revision = 0
        for (const payer of ['managed', 'byok'] as const) {
            await override(future(), revision++)
            const root = await ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: `old-root-${payer}`, payer })
            const claim = await ledger().claimExecution({ actor: client.actor, reservationId: root.id }), admissionId = apId()
            await ds.getRepository(HostingDispatchEntity).insert({ id: apId(), platformId: client.platformId, projectId: client.projectId!, identityId: client.identityId, tokenVersion: client.actor.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 's'.repeat(64), state: 'running', rootKey: apId(), reservationId: root.id, admissionId, dispatchId: claim.dispatchId, leaseUntil: new Date(Date.now() + 60000) })
            await override(past(16), revision++)
            await expect(gateway.execute({ scope: { admissionId, platformId: client.platformId, projectId: client.projectId! }, request: { callKey: `cutoff:${payer}`, attempt: 0, payer: payer === 'managed' ? { type: 'managed' } : { type: 'byok', configId }, model: payer === 'managed' ? 'sydekyks' : 'deepseek-flash', messages: [{ role: 'user', content: 'Synthetic test data' }], max_tokens: 1 } })).rejects.toThrow('ENTITLEMENT_EXPIRED')
            await ledger().finishExecution({ platformId: client.platformId, reservationId: root.id, dispatchId: claim.dispatchId! })
        }
        expect(complete).not.toHaveBeenCalled()
        expect(await ds.getRepository(HostingModelCallEntity).count()).toBe(0)
    })
    it('does not dispatch an old prepared root from another entitlement after a plan transition and policy reset', async () => {
        await override(future())
        const reservation = await ledger().reserveExecution({ actor: client.actor, projectId: client.projectId!, key: 'old-plan-root', payer: 'byok' })
        const original = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: reservation.grantId })
        // Trusted synthetic plan-transition fixture: no assessment credits issued.
        await ds.getRepository(HostingAccountEntity).update({ id: client.platformId }, { planId: 'assessment' })
        expect((await read()).state).toBe('review_required')
        await override(null, 1)
        const account = await tx.run({ dataSource: ds, fn: manager => tx.account({ manager, platformId: client.platformId }) })
        expect(subscriptionAccountActive(account, new Date())).toBe(true)
        expect(subscriptionGrantActive(account, original, new Date())).toBe(false)
        expect(() => tx.assertGrantActive({ account, grant: original, now: new Date() })).toThrow('GRANT_EXPIRED')
        expect((await ledger().claimExecution({ actor: client.actor, reservationId: reservation.id })).claimed).toBe(false)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: original.id })).consumed).toBe(0n)
    })
    it('requires clearing an explicit renewal override before assessment activation instead of minting unusable grants', async () => {
        await positionCoreAfterEnd(ds, client.platformId)
        await override(future())
        const before = await snapshot()
        await expect(createHostedAssessment({ dataSource: ds }).activate({ actor, enrollmentId: client.enrollmentId })).rejects.toThrow('ASSESSMENT_RENEWAL_OVERRIDE_REQUIRES_REVIEW')
        expect(await snapshot()).toBe(before)
        await override(null, 1)
        expect((await read()).state).toBe('unmanaged')
    })
    it('is current-operator-only, revision safe, idempotent and append-only without changing grants or LMS', async () => {
        const date = future(), before = await snapshot()
        await override(date, 0, 'same-command'); await override(date, 0, 'same-command')
        expect(await ds.getRepository(HostingSubscriptionCommandEntity).count()).toBe(1)
        expect(await snapshot()).toBe(before)
        await expect(override(past(1), 1, 'same-command')).rejects.toThrow('IDEMPOTENCY_CONFLICT')
        await expect(override(future(), 0)).rejects.toThrow('REVISION_CONFLICT')
        const input = { platformId: client.platformId, expectedRevision: 1, requestKey: apId(), renewalDueAt: date, reason: 'Synthetic fixture' }
        await expect(subscriptions().update({ actor: client.actor, input })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(subscriptions().read({ actor: client.actor, platformId: actor.platformId })).rejects.toThrow('OPERATOR_REQUIRED')
        await expect(subscriptions().update({ actor: { ...actor, tokenVersion: 'stale' }, input })).rejects.toThrow('OPERATOR_REQUIRED')
        expect(() => HostedSubscriptionUpdate.parse({ ...input, role: 'team' })).toThrow()
        await expect(override('9999-12-31T23:59:59.000Z', 1)).rejects.toThrow('INVALID_DATE')
        const command = await ds.getRepository(HostingSubscriptionCommandEntity).findOneByOrFail({ platformId: client.platformId })
        await expect(ds.getRepository(HostingSubscriptionCommandEntity).update({ id: command.id }, { reason: 'rewrite' })).rejects.toThrow('HISTORY_IMMUTABLE')
    })
    it('denies unpaid trial policies and leaves login/billing membership available while overdue', async () => {
        await expect(subscriptions().update({ actor, input: { platformId: actor.platformId, expectedRevision: 0, requestKey: apId(), renewalDueAt: future(), reason: 'Not a paid period' } })).rejects.toThrow('FUNDED_ENTITLEMENT_REQUIRED')
        await override(past(16))
        await expect(tx.run({ dataSource: ds, fn: manager => tx.member({ manager, actor: client.actor, admin: true }) })).resolves.toMatchObject({ platformRole: PlatformRole.ADMIN })
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: client.identityId })).tokenVersion).toBe(client.actor.tokenVersion)
    })
    it('blocks Partner operational scope from its own overdue home without pausing unrelated client owners or ordinary memberships', async () => {
        const owner = await fundedCore(ds, actor), access = createHostedAccess({ dataSource: ds })
        // An additional owned client cannot replace the canonical eligibility home.
        const otherOwned = await fundedCore(ds, actor)
        await ds.getRepository(HostingAccountEntity).update({ id: otherOwned.platformId }, { ownerIdentityId: client.identityId, created: new Date(0) })
        await access.setRole({ actor, identityId: client.identityId, role: 'partner', active: true })
        const assignment = await access.assignPartner({ actor, identityId: client.identityId, platformId: owner.platformId })
        const user = await ds.getRepository(UserEntity).findOneByOrFail({ id: assignment.userId })
        expect(await hasOperationalAccess({ manager: ds.manager, user })).toBe(true)
        await override(past(16))
        expect(await hasOperationalAccess({ manager: ds.manager, user })).toBe(false)
        await expect(access.enter({ actor: client.actor, platformId: owner.platformId })).rejects.toThrow('SUBSCRIPTION_OVERDUE')
        expect((await ds.getRepository(HostingAccessRoleEntity).findOneByOrFail({ id: client.identityId })).active).toBe(true)
        await expect(ledger().reserveExecution({ actor: owner.actor, projectId: owner.projectId!, key: 'unrelated-owner-still-works', payer: 'byok' })).resolves.toBeTruthy()
        const ordinary = await fundedCore(ds, actor)
        await ds.getRepository(UserEntity).insert({ id: apId(), identityId: client.identityId, platformId: ordinary.platformId, platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE })
        await expect(access.enter({ actor: client.actor, platformId: ordinary.platformId })).resolves.toMatchObject({ platformId: ordinary.platformId })
    })
    it('client cutoff denies assigned Partners as well as its owner, without revoking Partner qualification', async () => {
        const partner = await fundedCore(ds, actor), access = createHostedAccess({ dataSource: ds })
        await access.setRole({ actor, identityId: partner.identityId, role: 'partner', active: true })
        const assigned = await access.assignPartner({ actor, identityId: partner.identityId, platformId: client.platformId })
        await override(past(16))
        expect(await hasOperationalAccess({ manager: ds.manager, user: await ds.getRepository(UserEntity).findOneByOrFail({ id: assigned.userId }) })).toBe(false)
        expect((await ds.getRepository(HostingAccessRoleEntity).findOneByOrFail({ id: partner.identityId })).active).toBe(true)
        expect(await ds.getRepository(HostingSubscriptionEntity).count()).toBe(1)
    })
})
