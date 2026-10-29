import { apId } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HOSTED_WORKSPACE_CONCURRENCY, hostedConcurrencyUsage, hostedPlanLimits } from '../../src/app/hosting/hosting-concurrency'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { HostingActor } from '../../src/app/hosting/hosting-transactions'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, actor: HostingActor, projectId: string
const ledger = () => createHostedLedger({ dataSource: ds })
const account = () => ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })
const usage = async () => hostedConcurrencyUsage(ds.manager, await account())
beforeAll(async () => {
    ds = await migratedHostedPGlite()
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(() => {
    vi.unstubAllEnvs()
})
beforeEach(async () => {
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${entity.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Concurrency', lastName: 'Fixture', tokenVersion: 'initial' })
    const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-concurrency-subject-atleast32characters' }), identityId)
    actor = { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }; projectId = home.projectId!
    vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', identityId)
})
async function stopped(state: 'uncertain' | 'completed' = 'uncertain', expired = true) {
    const reservation = await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })
    const claim = await ledger().claimExecution({ actor, reservationId: reservation.id })
    const id = apId()
    await ds.getRepository(HostingDispatchEntity).insert({ id, platformId: actor.platformId, projectId, identityId: actor.identityId, originType: 'user', queueKey: apId(), payloadHash: 'x'.repeat(64), rootKey: apId(), reservationId: reservation.id, state, completionStatus: 'INTERNAL_ERROR', leaseUntil: new Date(Date.now() + (expired ? -60000 : 60000)) })
    if (state === 'uncertain') await ds.getRepository(HostingReservationEntity).update({ id: reservation.id }, { state: 'uncertain' })
    return { id, reservation, claim }
}
async function snapshot() {
    return JSON.stringify({ reservations: await ds.getRepository(HostingReservationEntity).find({ order: { id: 'ASC' } }), grants: await ds.getRepository(HostingGrantEntity).find({ order: { id: 'ASC' } }), account: await account() }, (_, value) => typeof value === 'bigint' ? value.toString() : value)
}
describe('hosted workspace scheduling and preserved billing holds', () => {
    it('admits twenty actual executions, refuses the twenty-first, and admits again after an unsent cancellation', async () => {
        expect(HOSTED_WORKSPACE_CONCURRENCY).toBe(20)
        expect(hostedPlanLimits('team').concurrency).toBe(20)
        expect(hostedPlanLimits('starter').users).toBe(10)
        const held = []
        for (let i = 0; i < 20; i++) held.push(await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' }))
        expect(await usage()).toBe(20)
        await expect(ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })).rejects.toThrow('HOSTING_CONCURRENCY_LIMIT')
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: held[0].id })
        await expect(ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })).resolves.toMatchObject({ state: 'reserved' })
    })
    it('reproduces five expired failed runs without releasing or rescaling any Credit hold', async () => {
        for (let i = 0; i < 5; i++) await stopped()
        const before = await snapshot()
        expect((await account()).activeExecutions).toBe(5)
        expect(await usage()).toBe(0)
        expect(await snapshot()).toBe(before)
        for (let i = 0; i < 20; i++) await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })
        expect((await account()).activeExecutions).toBe(25)
        expect(await usage()).toBe(20)
        await expect(ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })).rejects.toThrow('HOSTING_CONCURRENCY_LIMIT')
    })
    it('keeps unexpired, missing-lease and running dispatches counted', async () => {
        const root = await stopped('uncertain', false)
        expect(await usage()).toBe(1)
        await ds.getRepository(HostingDispatchEntity).update({ id: root.id }, { leaseUntil: null })
        expect(await usage()).toBe(1)
        await ds.getRepository(HostingDispatchEntity).update({ id: root.id }, { state: 'running', leaseUntil: new Date(0) })
        expect(await usage()).toBe(1)
    })
    it.each(['prepared', 'admitted', 'running', 'paused'] as const)('keeps a stopped tree counted while a child is %s', async state => {
        const root = await stopped()
        await ds.getRepository(HostingDispatchEntity).insert({ id: apId(), platformId: actor.platformId, projectId, identityId: actor.identityId, originType: 'user', queueKey: apId(), payloadHash: 'x'.repeat(64), rootKey: apId(), rootDispatchId: root.id, parentDispatchId: root.id, state })
        expect(await usage()).toBe(1)
    })
    it.each(['prepared', 'running', 'uncertain'] as const)('keeps supplier work counted until its %s call is fenced and expired', async state => {
        const root = await stopped('completed'), id = apId()
        await ds.getRepository(HostingModelCallEntity).insert({ id, platformId: actor.platformId, projectId, identityId: actor.identityId, segmentId: root.id, rootReservationId: root.reservation.id, admissionId: apId(), callKey: 'synthetic:0', attempt: 0, requestHash: 'x'.repeat(64), payer: 'managed', credentialFingerprint: 'x'.repeat(64), model: 'deepseek-flash', endpoint: 'diagnostic://no-network', state, leaseUntil: new Date(Date.now() + 60000) })
        expect(await usage()).toBe(1)
        await ds.getRepository(HostingModelCallEntity).update({ id }, { state: 'uncertain', leaseUntil: new Date(0) })
        const before = await snapshot()
        expect(await usage()).toBe(0)
        expect(await snapshot()).toBe(before)
    })
    it('retains correct accounting when a stopped root is later settled twice', async () => {
        const root = await stopped('completed')
        expect(await usage()).toBe(0)
        await ledger().finishExecution({ platformId: actor.platformId, reservationId: root.reservation.id, dispatchId: root.claim.dispatchId! })
        await ledger().finishExecution({ platformId: actor.platformId, reservationId: root.reservation.id, dispatchId: root.claim.dispatchId! })
        expect((await account()).activeExecutions).toBe(0)
        expect(await usage()).toBe(0)
    })
    it('enforces the same twenty-place ceiling when resuming a paused execution', async () => {
        const reservation = await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })
        const claim = await ledger().claimExecution({ actor, reservationId: reservation.id })
        await ledger().parkExecution({ platformId: actor.platformId, reservationId: reservation.id, dispatchId: claim.dispatchId! })
        const held = []
        for (let i = 0; i < 20; i++) held.push(await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' }))
        await expect(ledger().resumeExecution({ actor, reservationId: reservation.id })).rejects.toThrow('HOSTING_CONCURRENCY_LIMIT')
        await ledger().cancelUnsent({ platformId: actor.platformId, reservationId: held[0].id })
        await ledger().resumeExecution({ actor, reservationId: reservation.id })
        expect(await usage()).toBe(20)
    })
    it('keeps another workspace independent when the first has twenty reserved executions', async () => {
        for (let i = 0; i < 20; i++) await ledger().reserveExecution({ actor, projectId, key: apId(), payer: 'managed' })
        const original = await account(), identityId = apId()
        await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@test.invalid`, provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Other', lastName: 'Workspace', tokenVersion: 'initial' })
        const home = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-concurrency-subject-atleast32characters' }), identityId)
        await ledger().reserveExecution({ actor: { identityId, platformId: home.platformId, tokenVersion: home.tokenVersion }, projectId: home.projectId!, key: apId(), payer: 'managed' })
        expect(await usage()).toBe(20)
        expect((await account()).id).toBe(original.id)
        const other = await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: home.platformId })
        expect(await hostedConcurrencyUsage(ds.manager, other)).toBe(1)
    })
})
