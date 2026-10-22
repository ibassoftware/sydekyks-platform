import { apId } from '@activepieces/core-utils'
import { Principal, PrincipalType } from '@activepieces/shared'
import fastify from 'fastify'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { HostedAiFileEntity } from '../../src/app/hosting/hosting-ai-file-entity'
import { expireHostedAiFiles, hostedAiFiles, materializeHostedAiFiles, validateHostedAiFileIdsForActor } from '../../src/app/hosting/hosting-ai-files'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { bootstrapHostedOperator, migratedHostedPGlite, scopedAiActionPayload } from '../helpers/hosting-fixtures'

const log = fastify().log
let ds: DataSource, previousConnection: unknown, principal: Principal
let tenant: { platformId: string, projectId: string, userId: string, identityId: string, tokenVersion: string | null }
async function fixture() {
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@example.com`.toLowerCase(), provider: 'EMAIL', password: 'unused', verified: true, firstName: 'File', lastName: 'Owner' })
    const value = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-file-secret-at-least-32-characters' }), identityId)
    if (!value.projectId) throw new Error('Missing project')
    return { platformId: value.platformId, projectId: value.projectId, userId: value.userId, identityId, tokenVersion: value.tokenVersion ?? null }
}
function upload(text = 'confidential invoice 123', extra = {}) {
    return hostedAiFiles.upload({ principal, projectId: tenant.projectId, name: 'invoice.txt', mimeType: 'application/octet-stream', data: Buffer.from(text).toString('base64'), log, ...extra })
}
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    vi.spyOn(encryptUtils, 'getEncryptionKey').mockResolvedValue('0123456789abcdef0123456789abcdef')
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__'); Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
})
afterAll(async () => {
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds?.isInitialized) await ds.destroy()
    vi.restoreAllMocks(); vi.unstubAllEnvs()
})
beforeEach(async () => {
    tenant = await fixture()
    principal = { type: PrincipalType.USER, id: tenant.userId, platform: { id: tenant.platformId }, tokenVersion: tenant.tokenVersion ?? undefined }
})

describe('AI file ownership, encrypted lifecycle and zero-upload Credits', () => {
    it('stores encrypted bytes, exposes metadata only, deduplicates within owner/project and does not reserve Credits', async () => {
        const before = await ds.getRepository(HostingReservationEntity).countBy({ platformId: tenant.platformId })
        const file = await upload(), again = await upload()
        expect(again.id).toBe(file.id); expect(file.mimeType).toBe('text/plain')
        expect(Object.keys(file)).not.toContain('encryptedData'); expect(Object.keys(file)).not.toContain('text')
        const stored = await ds.getRepository(HostedAiFileEntity).findOneByOrFail({ id: file.id })
        expect(stored.encryptedData?.toString('utf8')).not.toContain('confidential invoice')
        expect((await hostedAiFiles.list({ principal, projectId: tenant.projectId, log })).data).toHaveLength(1)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: tenant.platformId })).toBe(before)
    })
    it('rejects different account/project access and never shares content-addressed uploads across owners', async () => {
        const file = await upload(), original = tenant
        const other = await fixture()
        tenant = other; principal = { type: PrincipalType.USER, id: other.userId, platform: { id: other.platformId }, tokenVersion: other.tokenVersion ?? undefined }
        await expect(hostedAiFiles.get({ principal, projectId: other.projectId, fileId: file.id, log })).rejects.toThrow('unavailable')
        await expect(hostedAiFiles.remove({ principal, projectId: original.projectId, fileId: file.id, log })).rejects.toThrow()
        const own = await upload(); expect(own.id).not.toBe(file.id)
    })
    it('immediately revokes deleted IDs and permits reupload as a new reference', async () => {
        const file = await upload()
        await hostedAiFiles.remove({ principal, projectId: tenant.projectId, fileId: file.id, log })
        await expect(validateHostedAiFileIdsForActor({ ...tenant, fileIds: [file.id], log })).rejects.toThrow('removed, expired')
        const row = await ds.getRepository(HostedAiFileEntity).findOneByOrFail({ id: file.id })
        expect(row.encryptedData).toBeNull(); expect(row.cacheKey).toBeNull()
        expect((await upload()).id).not.toBe(file.id)
    })
    it('checks expiry on every reuse before the cleanup sweep and removes encrypted content on sweep', async () => {
        const file = await upload()
        await ds.getRepository(HostedAiFileEntity).update({ id: file.id }, { expiresAt: new Date('2020-01-01T00:00:00Z') })
        await expect(validateHostedAiFileIdsForActor({ ...tenant, fileIds: [file.id], log })).rejects.toThrow('removed, expired')
        expect((await hostedAiFiles.list({ principal, projectId: tenant.projectId, log })).data).toHaveLength(0)
        await expireHostedAiFiles()
        expect((await ds.getRepository(HostedAiFileEntity).findOneByOrFail({ id: file.id })).encryptedData).toBeNull()
    })
    it('rechecks current identity token instead of trusting historical upload authority', async () => {
        const file = await upload()
        await expect(validateHostedAiFileIdsForActor({ ...tenant, tokenVersion: 'revoked-token', fileIds: [file.id], log })).rejects.toThrow()
    })
    it('requires a live running execution before any internal materialization', async () => {
        const file = await upload()
        await expect(ds.transaction(manager => materializeHostedAiFiles({ manager, scope: { admissionId: apId(), platformId: tenant.platformId, projectId: tenant.projectId }, identityId: apId(), fileIds: [file.id] }))).rejects.toThrow('HOSTING_AI_SEGMENT_DENIED')
    })
    it('revokes expired/deleted attachments during a legitimate running execution on every model read', async () => {
        const first = await upload('first confidential invoice'), second = await upload('second confidential invoice')
        const actor = { platformId: tenant.platformId, identityId: tenant.identityId, tokenVersion: tenant.tokenVersion }
        const ledger = createHostedLedger({ dataSource: ds })
        const reservation = await ledger.reserveExecution({ actor, projectId: tenant.projectId, key: apId(), payer: 'managed' })
        const claim = await ledger.claimExecution({ actor, reservationId: reservation.id }), admissionId = apId()
        expect(claim.claimed).toBe(true)
        const scope = { admissionId, platformId: tenant.platformId, projectId: tenant.projectId }
        await ds.getRepository(HostingDispatchEntity).insert({ id: apId(), platformId: tenant.platformId, projectId: tenant.projectId, identityId: tenant.identityId, tokenVersion: tenant.tokenVersion, originType: 'user', queueKey: apId(), payloadHash: 'a'.repeat(64), state: 'running', rootKey: apId(), reservationId: reservation.id, admissionId, dispatchId: claim.dispatchId, leaseUntil: new Date(Date.now() + 60_000), payload: scopedAiActionPayload({ platformId: tenant.platformId, projectId: tenant.projectId }) })
        const read = (fileIds: string[]) => ds.transaction(manager => materializeHostedAiFiles({ manager, scope, identityId: tenant.identityId, fileIds }))
        const before = await ds.getRepository(HostingReservationEntity).countBy({ platformId: tenant.platformId })
        const prepared = await read([first.id, second.id])
        expect(prepared.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('first confidential invoice') })]))
        expect(prepared.manifests.map(manifest => manifest.id)).toEqual([first.id, second.id])
        await ds.getRepository(HostedAiFileEntity).update({ id: first.id }, { expiresAt: new Date('2020-01-01T00:00:00Z') })
        await expect(read([first.id])).rejects.toThrow('removed, expired')
        await hostedAiFiles.remove({ principal, projectId: tenant.projectId, fileId: second.id, log })
        await expect(read([second.id])).rejects.toThrow('removed, expired')
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: tenant.platformId })).toBe(before)
    })
    it('enforces aggregate attachment bounds independently of individually valid uploads', async () => {
        const first = await upload('a'.repeat(25_000)), second = await upload('b'.repeat(25_000))
        await expect(validateHostedAiFileIdsForActor({ ...tenant, fileIds: [first.id, second.id], log })).rejects.toThrow('40,000')
        await expect(validateHostedAiFileIdsForActor({ ...tenant, fileIds: [first.id, first.id], log })).rejects.toThrow('distinct')
    })
})
