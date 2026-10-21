import { apId } from '@activepieces/core-utils'
import { AppConnectionScope, AppConnectionStatus, AppConnectionType, EngineResponseStatus, ExecutionType, FileType, FlowActionType, FlowRunStatus, FlowTriggerType, FlowVersionState, JobData, LATEST_FLOW_SCHEMA_VERSION, LATEST_JOB_DATA_SCHEMA_VERSION, PackageType, PieceType, PlatformRole, RunEnvironment, StreamStepProgress, TriggerHookType, WorkerJobType } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppConnectionEntity } from '../../src/app/app-connection/app-connection.entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FileEntity } from '../../src/app/file/file.entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { FlowEntity } from '../../src/app/flows/flow/flow.entity'
import { FlowRunEntity } from '../../src/app/flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../../src/app/flows/flow-version/flow-version-entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { createHostedAiGateway } from '../../src/app/hosting/hosting-ai-gateway'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { createHostedExecution, hostedConnectionRevision, HostingJobOrigin } from '../../src/app/hosting/hosting-execution'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { UserEntity } from '../../src/app/user/user-entity'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource
let execution: ReturnType<typeof createHostedExecution>
const piece = { pieceName: '@activepieces/piece-slack', pieceVersion: '0.1.0', packageType: PackageType.REGISTRY, pieceType: PieceType.OFFICIAL }
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    ds = await migratedHostedPGlite()
    execution = createHostedExecution({ dataSource: ds })
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
})
afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy(); vi.unstubAllEnvs() 
})
async function tenant() {
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@example.com`.toLowerCase(), provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Owner' })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-gadget-maintenance-secret-32-characters' })
    const value = await bootstrapHostedOperator(ds, onboarding, identityId)
    if (!value.projectId) throw new Error('Expected scoped project')
    return { ...value, projectId: value.projectId, identityId, origin: { type: 'user' as const, userId: value.userId, tokenVersion: value.tokenVersion } }
}
async function version(value: Awaited<ReturnType<typeof tenant>>) {
    const flowId = apId(), id = apId()
    await ds.getRepository(FlowEntity).insert({ id: flowId, projectId: value.projectId, externalId: apId() })
    await ds.getRepository(FlowVersionEntity).insert({ id, flowId, displayName: 'Scoped builder', schemaVersion: LATEST_FLOW_SCHEMA_VERSION, trigger: { name: 'trigger', type: FlowTriggerType.PIECE, displayName: 'Slack', valid: true, lastUpdatedDate: new Date().toISOString(), settings: { ...piece, triggerName: 'new_message', input: {}, propertySettings: {} } }, connectionIds: [], agentIds: [], valid: true, state: FlowVersionState.DRAFT, notes: [] })
    return ds.getRepository(FlowVersionEntity).findOneByOrFail({ id })
}
function request(value: Awaited<ReturnType<typeof tenant>>, jobType: WorkerJobType, extra: Record<string, unknown> = {}) {
    const jobId = apId()
    return { queueName: 'gadget-maintenance-tests', jobId, data: JobData.parse({ schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, platformId: value.platformId, projectId: value.projectId, jobType, requestId: jobId, webserverId: 'synthetic-maintenance', piece, ...extra }) }
}
async function start(delivery: ReturnType<typeof request>, origin: HostingJobOrigin) {
    const data = await execution.prepare({ ...delivery, origin }), prepared = { ...delivery, data }, queueToken = apId()
    const admissionId = await execution.admit({ ...prepared, queueToken })
    const fence = { ...prepared, queueToken, admissionId, connectionId: apId() }
    expect(await execution.start(fence)).toBe(true)
    return fence
}
async function grant(platformId: string) {
    return ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId, meter: 'execution' }) 
}
async function connection(value: Awaited<ReturnType<typeof tenant>>) {
    const auth = { type: AppConnectionType.CUSTOM_AUTH, props: { secret: 'synthetic-client-key' } }, id = apId()
    await ds.getRepository(AppConnectionEntity).insert({ id, platformId: value.platformId, projectIds: [value.projectId], ownerId: value.userId, externalId: apId(), displayName: 'Synthetic client connection', pieceName: piece.pieceName, pieceVersion: piece.pieceVersion, scope: AppConnectionScope.PROJECT, status: AppConnectionStatus.ACTIVE, type: AppConnectionType.CUSTOM_AUTH, value: await encryptUtils.encryptObject(auth) })
    const saved = await ds.getRepository(AppConnectionEntity).findOneByOrFail({ id })
    return { saved, auth, origin: { type: 'connection-refresh' as const, connectionId: id, credentialRevision: hostedConnectionRevision(saved), userId: value.userId, tokenVersion: value.tokenVersion } }
}

describe('hosted Gadget maintenance accounting and provenance', () => {
    it.each([WorkerJobType.EXECUTE_VALIDATION, WorkerJobType.EXECUTE_RESOLVE_CONNECTION_IDENTIFIER, WorkerJobType.EXECUTE_PROPERTY, WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION])('holds one Credit for %s and settles only confirmed maintenance at zero', async jobType => {
        const value = await tenant(), flowVersion = await version(value)
        const delivery = request(value, jobType, { connectionValue: { type: AppConnectionType.SECRET_TEXT, secret_text: 'synthetic-key' }, connectionType: AppConnectionType.SECRET_TEXT, flowVersion, actionOrTriggerName: 'new_message', propertyName: 'channel', input: {}, sampleData: {} })
        const origin: HostingJobOrigin = jobType === WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION ? { ...value.origin, type: 'operator-maintenance' } : value.origin
        const fence = await start(delivery, origin)
        expect((await grant(value.platformId)).consumed).toBe(1n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
        await execution.complete({ ...fence, status: EngineResponseStatus.OK })
        await execution.complete({ ...fence, status: EngineResponseStatus.OK })
        expect(await grant(value.platformId)).toMatchObject({ consumed: 0n, reserved: 0n })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: fence.admissionId })
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: dispatch.reservationId! })).toMatchObject({ state: 'settled', actualAmount: 0n })
        await expect(execution.admit({ ...delivery, queueToken: apId() })).rejects.toThrow('HOSTING_REPLAY_DENIED')
    })
    it('allows an authorized builder TEST on an unpublished trigger without installing a live source', async () => {
        const value = await tenant(), flowVersion = await version(value)
        const delivery = request(value, WorkerJobType.EXECUTE_TRIGGER_HOOK, { flowId: flowVersion.flowId, flowVersionId: flowVersion.id, hookType: TriggerHookType.TEST, test: true })
        await expect(execution.prepare({ ...delivery, origin: { type: 'scheduled' } })).rejects.toThrow('HOSTING_JOB_PROVENANCE_REQUIRED')
        const fence = await start(delivery, value.origin)
        await execution.complete({ ...fence, status: EngineResponseStatus.OK })
        expect((await grant(value.platformId)).consumed).toBe(0n)
    })
    it('denies cross-tenant user scope and stale token before admitting or charging', async () => {
        const value = await tenant(), other = await tenant(), delivery = request(value, WorkerJobType.EXECUTE_VALIDATION, { connectionValue: {} })
        await expect(execution.prepare({ ...delivery, origin: other.origin })).rejects.toThrow('HOSTING_ACCESS_DENIED')
        await execution.prepare({ ...delivery, origin: value.origin })
        await ds.getRepository(UserIdentityEntity).update({ id: value.identityId }, { tokenVersion: apId() })
        await expect(execution.admit({ ...delivery, queueToken: apId() })).rejects.toThrow('HOSTING_ACCESS_DENIED')
        expect((await grant(value.platformId)).consumed).toBe(0n)
    })
    it('rechecks operator authorization for metadata extraction before worker dispatch', async () => {
        const value = await tenant(), delivery = request(value, WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION)
        await expect(execution.prepare({ ...delivery, origin: value.origin })).rejects.toThrow('HOSTING_JOB_PROVENANCE_REQUIRED')
        await execution.prepare({ ...delivery, origin: { ...value.origin, type: 'operator-maintenance' } })
        await ds.getRepository(UserEntity).update({ id: value.userId }, { platformRole: PlatformRole.MEMBER })
        await expect(execution.admit({ ...delivery, queueToken: apId() })).rejects.toThrow('HOSTING_ACCESS_DENIED')
    })
    it('retains the provisional Credit and concurrency after an external maintenance timeout and reconciliation', async () => {
        const value = await tenant(), delivery = request(value, WorkerJobType.EXECUTE_VALIDATION, { connectionValue: {} }), fence = await start(delivery, value.origin)
        await execution.complete({ ...fence, status: EngineResponseStatus.TIMEOUT })
        const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: fence.admissionId })
        await execution.reconcile({ platformId: value.platformId, dispatchId: dispatch.id })
        expect(await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ id: dispatch.id })).toMatchObject({ state: 'uncertain' })
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: dispatch.reservationId! })).toMatchObject({ state: 'uncertain', actualAmount: null })
        expect((await grant(value.platformId)).consumed).toBe(1n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
        const ready = request(value, WorkerJobType.EXECUTE_VALIDATION, { connectionValue: {} }), publish = vi.fn(async () => undefined)
        await execution.prepare({ ...ready, origin: value.origin })
        await execution.recover({ publish, limit: 1 })
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ jobId: ready.jobId, state: 'prepared' }))
    })
    it('denies all model execution from a maintenance admission before supplier access', async () => {
        const value = await tenant(), fence = await start(request(value, WorkerJobType.EXECUTE_VALIDATION, { connectionValue: {} }), value.origin), complete = vi.fn()
        const gateway = createHostedAiGateway({ dataSource: ds, provider: { id: 'synthetic-no-network', endpoint: 'diagnostic://no-network', complete } })
        await expect(gateway.execute({ scope: { admissionId: fence.admissionId, platformId: value.platformId, projectId: value.projectId }, request: { callKey: 'forbidden-maintenance-ai', attempt: 0, payer: { type: 'managed' }, model: 'sydekyks', messages: [{ role: 'user', content: 'Forbidden' }], max_tokens: 1 } })).rejects.toThrow('HOSTING_AI_PATH_NOT_SUPPORTED')
        expect(complete).not.toHaveBeenCalled()
        await execution.complete({ ...fence, status: EngineResponseStatus.OK })
    })
    it('requires exact persisted connection scope, credentials and revision for a standalone refresh', async () => {
        const value = await tenant(), conn = await connection(value), delivery = request(value, WorkerJobType.EXECUTE_TOKEN_REFRESH, { connectionValue: conn.auth })
        await expect(execution.prepare({ ...delivery, origin: { type: 'connection-refresh', connectionId: conn.saved.id, credentialRevision: hostedConnectionRevision(conn.saved) } })).rejects.toThrow('HOSTING_JOB_PROVENANCE_REQUIRED')
        await expect(execution.prepare({ ...delivery, data: { ...delivery.data, connectionValue: { type: AppConnectionType.CUSTOM_AUTH, props: { secret: 'forged' } } } as JobData, origin: conn.origin })).rejects.toThrow('HOSTING_CONNECTION_REVISION_MISMATCH')
        const prepared = await execution.prepare({ ...delivery, origin: conn.origin })
        await ds.getRepository(AppConnectionEntity).update({ id: conn.saved.id }, { value: await encryptUtils.encryptObject({ ...conn.auth, props: { secret: 'rotated' } }) })
        await expect(execution.admit({ ...delivery, data: prepared, queueToken: apId() })).rejects.toThrow('HOSTING_CONNECTION_REVISION_MISMATCH')
        expect((await grant(value.platformId)).consumed).toBe(0n)
    })
    it('bounds standalone maintenance submissions without bypassing the paid admission hold', async () => {
        const value = await tenant()
        for (let index = 0; index < 60; index++) await execution.prepare({ ...request(value, WorkerJobType.EXECUTE_VALIDATION, { connectionValue: {} }), origin: value.origin })
        await expect(execution.prepare({ ...request(value, WorkerJobType.EXECUTE_VALIDATION, { connectionValue: {} }), origin: value.origin })).rejects.toThrow('HOSTING_MAINTENANCE_RATE_LIMIT')
        expect(await ds.getRepository(HostingDispatchEntity).countBy({ platformId: value.platformId })).toBe(60)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(0)
    })
    it.each(['rotation', 'unshare'])('refuses a refresh %s after admission but before worker start without charging', async change => {
        const value = await tenant(), conn = await connection(value), delivery = request(value, WorkerJobType.EXECUTE_TOKEN_REFRESH, { connectionValue: conn.auth })
        const data = await execution.prepare({ ...delivery, origin: conn.origin }), queueToken = apId()
        const admissionId = await execution.admit({ ...delivery, data, queueToken })
        if (change === 'rotation') await ds.getRepository(AppConnectionEntity).update({ id: conn.saved.id }, { value: await encryptUtils.encryptObject({ ...conn.auth, props: { secret: 'replacement' } }) })
        else await ds.getRepository(AppConnectionEntity).update({ id: conn.saved.id }, { projectIds: [] })
        expect(await execution.start({ ...delivery, data, queueToken, admissionId, connectionId: apId() })).toBe(false)
        expect(await grant(value.platformId)).toMatchObject({ consumed: 0n, reserved: 0n })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('shares the running workflow hold for a synchronous connection refresh at concurrency one', async () => {
        const value = await tenant(), flowVersion = await version(value), runId = apId(), logsFileId = apId()
        await ds.getRepository(FileEntity).insert({ id: logsFileId, platformId: value.platformId, projectId: value.projectId, type: FileType.FLOW_RUN_LOG, location: 'DB', data: Buffer.from('{}') })
        await ds.getRepository(FlowRunEntity).insert({ id: runId, flowId: flowVersion.flowId, flowVersionId: flowVersion.id, projectId: value.projectId, triggeredBy: value.userId, environment: RunEnvironment.TESTING, status: FlowRunStatus.QUEUED, tags: [], steps: {} })
        const parent = await start(request(value, WorkerJobType.EXECUTE_FLOW, { runId, logsFileId, flowId: flowVersion.flowId, flowVersionId: flowVersion.id, environment: RunEnvironment.TESTING, executionType: ExecutionType.BEGIN, streamStepProgress: StreamStepProgress.NONE, payload: { type: 'inline', value: {} } }), value.origin)
        const conn = await connection(value), child = await start(request(value, WorkerJobType.EXECUTE_TOKEN_REFRESH, { connectionValue: conn.auth }), { type: 'connection-refresh', connectionId: conn.saved.id, credentialRevision: hostedConnectionRevision(conn.saved), parentAdmissionId: parent.admissionId })
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId, kind: 'execution' })).toBe(1)
        await execution.complete({ ...child, status: EngineResponseStatus.OK })
        expect((await grant(value.platformId)).consumed).toBe(1n)
        await execution.flowReceipt({ admissionId: parent.admissionId, connectionId: parent.connectionId, projectId: value.projectId, runId, status: FlowRunStatus.SUCCEEDED })
        await execution.complete({ ...parent, status: EngineResponseStatus.OK })
        expect((await grant(value.platformId)).consumed).toBe(1n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('charges one Credit for a user-started action rather than classifying it as maintenance', async () => {
        const value = await tenant(), fence = await start(request(value, WorkerJobType.EXECUTE_ACTION, { expiresAt: Date.now() + 60_000, step: { name: 'step_1', type: FlowActionType.CODE, displayName: 'Code', valid: true, lastUpdatedDate: new Date().toISOString(), settings: { sourceCode: { code: 'export const code = async () => ({ done: true })', packageJson: '{}' }, input: {} } } }), value.origin)
        await execution.complete({ ...fence, status: EngineResponseStatus.OK })
        expect((await grant(value.platformId)).consumed).toBe(1n)
    })
})
