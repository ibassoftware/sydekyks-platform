import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { PlatformRole, UserIdentityProvider, UserStatus } from '@activepieces/shared'
import fastify from 'fastify'
import { DataSource } from 'typeorm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { HostingAccessRoleEntity } from '../../src/app/hosting/hosting-access-entities'
import { hasOperationalAccess } from '../../src/app/hosting/hosting-access-policy'
import { HostingAccountEntity, HostingGrantEntity } from '../../src/app/hosting/hosting-entities'
import { identityAdmission } from '../../src/app/hosting/hosting-identity-admission'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { HostingTrainerAssignmentEntity, HostingTrainerRoleEntity, HostingTrainerSetupEntity } from '../../src/app/hosting/hosting-trainer-entities'
import { assertTrainerRecipient, isPrivilegedTrainerIdentity } from '../../src/app/hosting/hosting-trainer-policy'
import { createPlatformTrainers } from '../../src/app/hosting/hosting-trainers'
import { HostingActor, hostingTransactions as tx } from '../../src/app/hosting/hosting-transactions'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource, operator: HostingActor, trainerId: string, home: Awaited<ReturnType<ReturnType<typeof createHostedOnboarding>['provision']>>
const log = fastify().log
const onboarding = ()=>createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-trainer-subject-secret-at-least32' })
const service = ()=>createPlatformTrainers({ dataSource: ds, onboarding: onboarding(), log })
async function identity() {
    const id = apId();await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id.toLowerCase()}@test.invalid`, provider: UserIdentityProvider.EMAIL, password: 'unused-service-fixture', verified: true, firstName: 'Trainer', lastName: 'Fixture', tokenVersion: 'initial' });return id
}
async function trainerView() {
    const identity = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: trainerId });return (await service().adminList({ actor: operator, email: identity.email })).trainers[0]
}
const pre = (v: { revision: number, stateHash: string })=>({ expectedRevision: v.revision, expectedState: v.stateHash, requestKey: apId() })
async function role(active = true) {
    return service().adminCommand({ actor: operator, action: 'role', input: { ...pre(await trainerView()), trainerIdentityId: trainerId, active } })
}
async function actor() {
    return { identityId: trainerId, platformId: home.platformId, tokenVersion: (await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: trainerId })).tokenVersion }
}
async function assign(kind: 'partner' | 'client', targetId: string) {
    return service().adminCommand({ actor: operator, action: 'assignment', input: { ...pre(await trainerView()), trainerIdentityId: trainerId, kind, targetId, active: true } })
}
async function newRecipient(kind: 'partner' | 'client' = 'partner') {
    const a = await actor(), view = await service().portfolio({ actor: a });const result = await service().onboard({ actor: a, input: { ...pre(view), email: `${apId().toLowerCase()}@test.invalid`, kind, workspaceName: 'Synthetic recipient' } });if (!result.setupUrl) throw new Error('Missing fixture link');const token = new URLSearchParams(new URL(result.setupUrl).hash.slice(1)).get('token')!;return { result, token }
}
beforeAll(async ()=>{
    ds = await migratedHostedPGlite()
})
afterAll(async ()=>{
    if (ds?.isInitialized) await ds.destroy()
})
afterEach(()=>vi.unstubAllEnvs())
beforeEach(async ()=>{
    vi.stubEnv('AP_SERVICE_MODE', 'hosted');vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', '');vi.stubEnv('AP_FRONTEND_URL', 'https://trainer.test.invalid')
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(e=>`"${e.tableName}"`).join(',')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    const op = await identity(), opHome = await bootstrapHostedOperator(ds, onboarding(), op);vi.stubEnv('AP_HOSTED_OPERATOR_IDENTITY_IDS', op)
    operator = { identityId: op, platformId: opHome.platformId, tokenVersion: opHome.tokenVersion };trainerId = await identity();home = await onboarding().provision({ identityId: trainerId, name: 'Trainer home', operator })
})
describe('current scoped Platform Trainer authority', ()=>{
    it('grants distinct persisted authority, invalidates previous session and protects inactive role history', async ()=>{
        const old = await actor();await role();await expect(service().portfolio({ actor: old })).rejects.toThrow('TRAINER_REQUIRED')
        expect((await service().portfolio({ actor: await actor() })).partners).toEqual([])
        expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: trainerId })).toBe(0)
        await role(false);expect(await isPrivilegedTrainerIdentity(ds.manager, trainerId)).toBe(true)
        expect(await ds.getRepository(HostingTrainerRoleEntity).findOneByOrFail({ id: trainerId })).toMatchObject({ active: false })
    })
    it('rejects ordinary admins and stale CAS; role command replay does not rotate twice', async ()=>{
        const current = await trainerView(), input = { ...pre(current), trainerIdentityId: trainerId, active: true }
        await expect(service().adminList({ actor: await actor() })).rejects.toThrow('OPERATOR_REQUIRED')
        await service().adminCommand({ actor: operator, action: 'role', input });const version = (await actor()).tokenVersion
        expect((await service().adminCommand({ actor: operator, action: 'role', input })).replayed).toBe(true)
        expect((await actor()).tokenVersion).toBe(version)
        await expect(service().adminCommand({ actor: operator, action: 'role', input: { ...input, requestKey: apId() } })).rejects.toThrow('REVISION_CONFLICT')
    })
    it('never claims an existing email or creates a role, workspace or grant on rejection', async ()=>{
        await role();const existing = await identity(), row = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: existing }), counts = [await ds.getRepository(HostingAccountEntity).count(), await ds.getRepository(HostingGrantEntity).count()]
        const a = await actor(), p = await service().portfolio({ actor: a });await expect(service().onboard({ actor: a, input: { ...pre(p), email: row.email, kind: 'partner', workspaceName: 'Do not create' } })).rejects.toThrow('ONBOARDING_UNAVAILABLE')
        expect(await ds.getRepository(HostingTrainerAssignmentEntity).count()).toBe(0);expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: existing })).toBe(0)
        expect([await ds.getRepository(HostingAccountEntity).count(), await ds.getRepository(HostingGrantEntity).count()]).toEqual(counts)
    })
    it('admits only a new recipient through normal trial provisioning, with no global Partner approval or email ownership claim', async ()=>{
        await role();const { token } = await newRecipient(), row = await ds.getRepository(HostingTrainerSetupEntity).findOneByOrFail({ tokenDigest: createHash('sha256').update(token).digest('hex') })
        const result = await service().redeem({ token, password: 'Synthetic-Trainer-Password-84!', fullName: 'New Learner Fixture' })
        expect(await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: result.platformId })).toMatchObject({ ownerIdentityId: row.identityId, planId: 'trial' })
        expect(await ds.getRepository(HostingAccessRoleEntity).countBy({ id: row.identityId })).toBe(0)
        const recipient = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: row.identityId });expect(await identityAdmission(ds.manager, recipient)).toMatchObject({ admissionSource: 'trainer', emailOwnershipVerified: false })
        const trainerActor = await actor(); await tx.run({ dataSource: ds, fn: manager=>assertTrainerRecipient({ manager, actor: trainerActor, identityId: row.identityId, audience: 'partner' }) })
        await expect(service().redeem({ token, password: 'Synthetic-Trainer-Password-84!', fullName: 'Replayed' })).rejects.toThrow('SETUP_UNAVAILABLE')
    })
    it('revokes pending setup on removal; reactivation does not resurrect it', async ()=>{
        await role();const { token } = await newRecipient();await role(false);await role(true)
        // Service reports stale issuer authority; the public controller masks this as setup unavailable.
        await expect(service().inspect(token)).rejects.toThrow('TRAINER_REQUIRED')
        expect((await service().portfolio({ actor: await actor() })).pending).toEqual([])
    })
    it('materializes only scoped OPERATOR access while preserving client owner ADMIN and denying unrelated scope', async ()=>{
        await role();const clientId = await identity(), client = await onboarding().provision({ identityId: clientId, name: 'Assigned client', operator }), unrelated = await identity();await assign('client', client.platformId)
        const row = await ds.getRepository(UserEntity).findOneByOrFail({ identityId: trainerId, platformId: client.platformId });expect(row).toMatchObject({ platformRole: PlatformRole.OPERATOR, status: UserStatus.ACTIVE })
        expect(await hasOperationalAccess({ manager: ds.manager, user: row })).toBe(true)
        expect(await ds.getRepository(UserEntity).findOneByOrFail({ identityId: clientId, platformId: client.platformId })).toMatchObject({ platformRole: PlatformRole.ADMIN })
        const trainerActor = await actor(); await expect(tx.run({ dataSource: ds, fn: manager=>assertTrainerRecipient({ manager, actor: trainerActor, identityId: unrelated, audience: 'partner' }) })).rejects.toThrow('SCOPE_REQUIRED')
        const assignment = (await trainerView()).assignments[0];await service().adminCommand({ actor: operator, action: 'assignment', input: { ...pre(await trainerView()), trainerIdentityId: trainerId, assignmentId: assignment.id, active: false } })
        expect(await hasOperationalAccess({ manager: ds.manager, user: row })).toBe(false)
    })
})
