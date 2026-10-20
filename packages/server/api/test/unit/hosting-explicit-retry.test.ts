import { apId, ErrorCode } from '@activepieces/core-utils'
import { EngineResponseStatus, ExecuteFlowJobData, ExecutionType, FileType, FlowActionType, FlowRetryStrategy, FlowRunStatus, FlowTrigger, FlowTriggerType, FlowVersionState, LATEST_FLOW_SCHEMA_VERSION, LATEST_JOB_DATA_SCHEMA_VERSION, RunEnvironment, StreamStepProgress, WorkerJobType } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FileEntity } from '../../src/app/file/file.entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { FlowEntity } from '../../src/app/flows/flow/flow.entity'
import { flowRunService } from '../../src/app/flows/flow-run/flow-run-service'
import type { FastifyBaseLogger } from 'fastify'
import { FlowRunEntity } from '../../src/app/flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../../src/app/flows/flow-version/flow-version-entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { createHostedExecution, HostedRunStartRefused } from '../../src/app/hosting/hosting-execution'
import { createHostedExplicitRetry, hostedRetryRunId } from '../../src/app/hosting/hosting-explicit-retry'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { HostingError } from '../../src/app/hosting/hosting-transactions'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedLedger } from '../../src/app/hosting/hosting-ledger'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

let ds: DataSource
let previousAllowlist: string | undefined
let previousConnection: unknown
beforeAll(async () => {
    previousAllowlist = process.env['AP_HOSTED_OPERATOR_IDENTITY_IDS']
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
})
afterAll(async () => {
    if (previousAllowlist === undefined) delete process.env['AP_HOSTED_OPERATOR_IDENTITY_IDS']
    else process.env['AP_HOSTED_OPERATOR_IDENTITY_IDS'] = previousAllowlist
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds?.isInitialized) await ds.destroy()
})

async function failedRoot(payer: 'managed' | 'byok' = 'managed') {
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@example.com`.toLowerCase(), provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Owner' })
    const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-retry-secret-at-least-32-characters' })
    const tenant = await bootstrapHostedOperator(ds, onboarding, identityId)
    if (!tenant.projectId) throw new Error('Missing fixture project')
    const projectId = tenant.projectId
    const origin = { type: 'user' as const, userId: tenant.userId, tokenVersion: tenant.tokenVersion }
    const actor = { platformId: tenant.platformId, identityId, tokenVersion: tenant.tokenVersion }
    const flowId = apId(), flowVersionId = apId(), runId = apId(), configId = apId()
    if (payer === 'byok') await ds.getRepository(AIProviderEntity).insert({ id: configId, platformId: tenant.platformId, provider: 'deepseek', displayName: 'Synthetic exact client key', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-retry-byok-key-not-real' }), config: {}, status: 'active', enabledForChat: false, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
    await ds.getRepository(FlowEntity).insert({ id: flowId, projectId, externalId: apId() })
    const trigger = {
        name: 'trigger', type: FlowTriggerType.PIECE, displayName: 'Run manually', valid: true,
        settings: { pieceName: '@activepieces/piece-manual-trigger', pieceVersion: '0.0.8', triggerName: 'manual_trigger', input: {}, propertySettings: {} },
        nextAction: { name: 'ai', type: FlowActionType.PIECE, settings: { pieceName: '@activepieces/piece-ai', actionName: 'askAi', input: { provider: payer === 'byok' ? { provider: 'deepseek', configId } : { provider: 'activepieces' }, model: payer === 'byok' ? 'deepseek-flash' : 'sydekyks' } } },
    } as unknown as FlowTrigger
    await ds.getRepository(FlowVersionEntity).insert({ id: flowVersionId, flowId, displayName: 'Retry fixture', schemaVersion: LATEST_FLOW_SCHEMA_VERSION, trigger, connectionIds: [], agentIds: [], valid: true, state: FlowVersionState.LOCKED, notes: [] })
    await ds.getRepository(FlowRunEntity).insert({ id: runId, flowId, flowVersionId, projectId, triggeredBy: tenant.userId, environment: RunEnvironment.TESTING, status: FlowRunStatus.QUEUED, tags: [], steps: {} })
    const data: ExecuteFlowJobData = { schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, platformId: tenant.platformId, projectId, jobType: WorkerJobType.EXECUTE_FLOW, flowId, flowVersionId, runId, environment: RunEnvironment.TESTING, executionType: ExecutionType.BEGIN, streamStepProgress: StreamStepProgress.NONE, logsFileId: apId(), payload: { type: 'inline', value: { demo: true } } }
    await ds.getRepository(FileEntity).insert({ id: data.logsFileId, platformId: tenant.platformId, projectId, type: FileType.FLOW_RUN_LOG, location: 'DB', data: Buffer.from('{}') })
    const delivery = { queueName: 'explicit-retry-fixture', jobId: runId, data, queueToken: 'synthetic-worker-claim' }
    const execution = createHostedExecution({ dataSource: ds })
    await execution.prepare({ ...delivery, origin })
    const admissionId = await execution.admit(delivery)
    const fence = { queueName: delivery.queueName, jobId: runId, queueToken: delivery.queueToken, connectionId: 'synthetic-worker', admissionId }
    expect(await execution.start({ ...delivery, ...fence })).toBe(true)
    await execution.flowReceipt({ admissionId, projectId, runId, status: FlowRunStatus.FAILED })
    await execution.complete({ ...fence, status: EngineResponseStatus.OK })
    const root = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ flowRunId: runId })
    const params = { platformId: tenant.platformId, projectId, flowRunId: runId, flowVersionId, strategy: FlowRetryStrategy.ON_LATEST_VERSION, origin }
    return { ...params, params, root, data, actor, execution, configId }
}

describe('bulk retry service result mapping', () => {
    it('returns a safe denied result alongside a successful retry when HostingError has no nested error payload', async () => {
        const value = await failedRoot(), secondId = apId(), successId = apId()
        const first = await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: value.flowRunId })
        await ds.getRepository(FlowRunEntity).update({ id: first.id }, { environment: RunEnvironment.PRODUCTION })
        await ds.getRepository(FlowRunEntity).insert({ ...first, id: secondId, environment: RunEnvironment.PRODUCTION })
        const service = flowRunService({ info: vi.fn() } as unknown as FastifyBaseLogger)
        const retry = vi.spyOn(service, 'retry').mockImplementation(async args => {
            if (args.flowRunId === first.id) throw new HostingError('HOSTING_CREDITS_EXHAUSTED')
            return { ...first, id: successId }
        })
        try {
            const results = await service.bulkRetry({ projectId: value.projectId, flowRunIds: [first.id, secondId], strategy: FlowRetryStrategy.ON_LATEST_VERSION, hostedOrigin: value.origin })
            expect(results).toHaveLength(2)
            expect(results.find(result => result.id === first.id)?.error).toMatchObject({ errorCode: ErrorCode.INTERNAL_SERVER_ERROR, errorMessage: expect.stringContaining('Check Credits') })
            expect(results.some(result => result.id === successId)).toBe(true)
            expect(retry).toHaveBeenCalledTimes(2)
            expect(JSON.stringify(results)).not.toContain('HOSTING_CREDITS_EXHAUSTED')
        }
        finally { retry.mockRestore() }
    })
})

describe('explicit hosted full workflow retry', () => {
    it.each(['managed', 'byok'] as const)('creates a new %s root and charges a fresh execution once', async payer => {
        const value = await failedRoot(payer)
        const retry = createHostedExplicitRetry({ dataSource: ds })
        const prepared = await retry.prepare(value.params)
        expect(prepared.enqueue).toBe(true)
        expect(prepared.run.id).toBe(hostedRetryRunId(value.platformId, value.projectId, value.flowRunId))
        expect(prepared.run.id).not.toBe(value.flowRunId)
        const data = { ...value.data, runId: prepared.run.id, logsFileId: prepared.logsFileId }
        const delivery = { queueName: 'explicit-retry-fixture', jobId: prepared.run.id, data, queueToken: 'retry-worker-claim' }
        await value.execution.prepare({ ...delivery, origin: value.origin })
        const admissionId = await value.execution.admit(delivery)
        expect(await value.execution.start({ ...delivery, admissionId, connectionId: 'synthetic-worker' })).toBe(true)
        const next = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ flowRunId: prepared.run.id })
        expect(next.reservationId).not.toBe(value.root.reservationId)
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: next.reservationId! })).payer).toBe(payer)
        const duplicate = await retry.prepare(value.params)
        expect(duplicate.run.id).toBe(prepared.run.id)
        expect(duplicate.enqueue).toBe(false)
        const balance = await createHostedLedger({ dataSource: ds }).balance({ actor: value.actor })
        expect(balance.find(item => item.meter === 'execution')?.available).toBe(998n)
        expect((await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: value.flowRunId })).status).toBe(FlowRunStatus.FAILED)
    })

    it('recovers an unsent successor after a crash without creating another run', async () => {
        const value = await failedRoot()
        const retry = createHostedExplicitRetry({ dataSource: ds })
        const first = await retry.prepare(value.params)
        const duplicate = await retry.prepare(value.params)
        expect(duplicate.run.id).toBe(first.run.id)
        expect(duplicate.logsFileId).toBe(first.logsFileId)
        expect(duplicate.enqueue).toBe(true)
    })

    it('commits a terminal uncharged refusal when access expires before the new retry dispatch', async () => {
        const value = await failedRoot()
        const prepared = await createHostedExplicitRetry({ dataSource: ds }).prepare(value.params)
        await ds.getRepository(HostingAccountEntity).update({ id: value.platformId }, { validUntil: new Date(0) })
        const data = { ...value.data, runId: prepared.run.id, logsFileId: prepared.logsFileId }
        await expect(value.execution.prepare({ queueName: 'explicit-retry-fixture', jobId: prepared.run.id, data, origin: value.origin })).rejects.toBeInstanceOf(HostedRunStartRefused)
        const refused = await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: prepared.run.id })
        expect(refused.status).toBe(FlowRunStatus.FAILED)
        expect(refused.finishTime).toBeTruthy()
        expect(await ds.getRepository(HostingDispatchEntity).existsBy({ flowRunId: prepared.run.id })).toBe(false)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(1)
    })

    it('refuses resume-from-failed-step, nonterminal runs, nested runs and missing user provenance', async () => {
        const value = await failedRoot()
        const retry = createHostedExplicitRetry({ dataSource: ds })
        await expect(retry.prepare({ ...value.params, strategy: FlowRetryStrategy.FROM_FAILED_STEP })).rejects.toThrow('FULL_WORKFLOW_RETRY_REQUIRED')
        await expect(retry.prepare({ ...value.params, origin: undefined })).rejects.toThrow('JOB_PROVENANCE_REQUIRED')
        await ds.getRepository(FlowRunEntity).update({ id: value.flowRunId }, { status: FlowRunStatus.INTERNAL_ERROR })
        await expect(retry.prepare(value.params)).rejects.toThrow('TERMINAL_ROOT_RETRY_REQUIRED')
        await ds.getRepository(FlowRunEntity).update({ id: value.flowRunId }, { status: FlowRunStatus.FAILED, parentRunId: apId() })
        await expect(retry.prepare(value.params)).rejects.toThrow('TERMINAL_ROOT_RETRY_REQUIRED')
    })

    it('rejects unresolved dispatch and supplier liability before creating a successor', async () => {
        const value = await failedRoot()
        const retry = createHostedExplicitRetry({ dataSource: ds })
        await ds.getRepository(HostingDispatchEntity).update({ id: value.root.id }, { state: 'uncertain' })
        await expect(retry.prepare(value.params)).rejects.toThrow('PRIOR_WORK_UNRESOLVED')
        await ds.getRepository(HostingDispatchEntity).update({ id: value.root.id }, { state: 'completed' })
        await ds.getRepository(HostingReservationEntity).update({ id: value.root.reservationId! }, { state: 'uncertain' })
        await expect(retry.prepare(value.params)).rejects.toThrow('PRIOR_WORK_UNRESOLVED')
        expect(await ds.getRepository(FlowRunEntity).existsBy({ id: hostedRetryRunId(value.platformId, value.projectId, value.flowRunId) })).toBe(false)
    })

    it('refuses an uncertain provider call even if the root receipt has already settled', async () => {
        const value = await failedRoot()
        await ds.getRepository(HostingModelCallEntity).insert({ id: apId(), platformId: value.platformId, projectId: value.projectId, segmentId: value.root.id, rootReservationId: value.root.reservationId!, admissionId: value.root.admissionId!, identityId: value.actor.identityId, callKey: 'prior:uncertain', attempt: 0, requestHash: 'x'.repeat(64), payer: 'managed', credentialFingerprint: 'y'.repeat(64), model: 'sydekyks', endpoint: 'diagnostic://no-network', state: 'uncertain', leaseUntil: new Date() })
        await expect(createHostedExplicitRetry({ dataSource: ds }).prepare(value.params)).rejects.toThrow('PRIOR_WORK_UNRESOLVED')
        expect(await ds.getRepository(FlowRunEntity).existsBy({ id: hostedRetryRunId(value.platformId, value.projectId, value.flowRunId) })).toBe(false)
    })

    it.each(['managed', 'byok'] as const)('refuses an exhausted %s rerun before worker start without charging', async payer => {
        const value = await failedRoot(payer)
        const prepared = await createHostedExplicitRetry({ dataSource: ds }).prepare(value.params)
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: grant.consumed })
        const data = { ...value.data, runId: prepared.run.id, logsFileId: prepared.logsFileId }
        const delivery = { queueName: 'explicit-retry-fixture', jobId: prepared.run.id, data, queueToken: 'exhausted-retry-claim' }
        await value.execution.prepare({ ...delivery, origin: value.origin })
        await expect(value.execution.admit(delivery)).rejects.toThrow('CREDITS_EXHAUSTED')
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: grant.id })).consumed).toBe(1n)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(1)
        expect(await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ flowRunId: prepared.run.id })).toMatchObject({ state: 'cancelled', admissionId: null })
        expect((await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: prepared.run.id })).failedStep).toEqual({ name: 'trigger', displayName: 'Credits', message: 'Not enough Credits are available to start this Mission. Check billing or contact your workspace administrator.' })
    })

    it.each(['removed', 'disabled', 'project-scope', 'model-scope'] as const)('refuses an unavailable exact BYOK key (%s) before admission without charging or fallback', async reason => {
        const value = await failedRoot('byok')
        const prepared = await createHostedExplicitRetry({ dataSource: ds }).prepare(value.params)
        if (reason === 'removed') await ds.getRepository(AIProviderEntity).delete({ id: value.configId })
        if (reason === 'disabled') await ds.getRepository(AIProviderEntity).update({ id: value.configId }, { status: 'disabled' })
        if (reason === 'project-scope') await ds.getRepository(AIProviderEntity).update({ id: value.configId }, { projectScope: 'selected', projectIds: [apId()] })
        if (reason === 'model-scope') await ds.getRepository(AIProviderEntity).update({ id: value.configId }, { modelScope: 'selected', modelIds: ['other-model'] })
        const data = { ...value.data, runId: prepared.run.id, logsFileId: prepared.logsFileId }
        const delivery = { queueName: 'explicit-retry-fixture', jobId: prepared.run.id, data, queueToken: 'removed-key-claim' }
        await value.execution.prepare({ ...delivery, origin: value.origin })
        await expect(value.execution.admit(delivery)).rejects.toThrow('BYOK_SCOPE_DENIED')
        expect(await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ flowRunId: prepared.run.id })).toMatchObject({ state: 'cancelled', admissionId: null, reservationId: null })
        expect(await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: prepared.run.id })).toMatchObject({ status: FlowRunStatus.FAILED, failedStep: { displayName: 'AI connection', message: 'The selected client AI key is unavailable for this Mission. Ask your workspace administrator to update its AI connection, then try again.' } })
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).toMatchObject({ consumed: 1n, reserved: 0n })
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(1)
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ platformId: value.platformId })).toBe(0)
    })

    it('rechecks removal after admission and releases the unsent execution hold before worker start', async () => {
        const value = await failedRoot('byok')
        const prepared = await createHostedExplicitRetry({ dataSource: ds }).prepare(value.params)
        const data = { ...value.data, runId: prepared.run.id, logsFileId: prepared.logsFileId }
        const delivery = { queueName: 'explicit-retry-fixture', jobId: prepared.run.id, data, queueToken: 'removed-after-admit-claim' }
        await value.execution.prepare({ ...delivery, origin: value.origin })
        const admissionId = await value.execution.admit(delivery)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).reserved).toBe(1n)
        await ds.getRepository(AIProviderEntity).delete({ id: value.configId })
        expect(await value.execution.start({ ...delivery, admissionId, connectionId: 'never-started-worker' })).toBe(false)
        expect(await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).toMatchObject({ consumed: 1n, reserved: 0n })
        const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ flowRunId: prepared.run.id })
        expect(dispatch.state).toBe('cancelled')
        expect(await ds.getRepository(HostingReservationEntity).findOneByOrFail({ id: dispatch.reservationId! })).toMatchObject({ payer: 'byok', state: 'released', actualAmount: 0n })
        expect((await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: prepared.run.id })).failedStep?.displayName).toBe('AI connection')
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ platformId: value.platformId })).toBe(0)
    })

    it.each(['credits', 'removed-key'] as const)('reruns a proven never-admitted %s refusal after fixing it, using the persisted trigger payload once', async reason => {
        const value = await failedRoot(reason === 'removed-key' ? 'byok' : 'managed'), retry = createHostedExplicitRetry({ dataSource: ds })
        const refused = await retry.prepare(value.params), grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })
        if (reason === 'credits') await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: grant.consumed })
        else await ds.getRepository(AIProviderEntity).update({ id: value.configId }, { status: 'disabled' })
        const deniedData = { ...value.data, runId: refused.run.id, logsFileId: refused.logsFileId }
        const denied = { queueName: 'explicit-retry-fixture', jobId: refused.run.id, data: deniedData, queueToken: 'never-admitted-claim' }
        await value.execution.prepare({ ...denied, origin: value.origin })
        await expect(value.execution.admit(denied)).rejects.toThrow(reason === 'credits' ? 'CREDITS_EXHAUSTED' : 'BYOK_SCOPE_DENIED')
        expect((await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: refused.run.id })).steps ?? {}).toEqual({})
        await ds.getRepository(HostingGrantEntity).update({ id: grant.id }, { amount: 1000n })
        if (reason === 'removed-key') await ds.getRepository(AIProviderEntity).update({ id: value.configId }, { status: 'active' })
        const nextParams = { ...value.params, flowRunId: refused.run.id, hasTriggerPayload: false }
        const next = await retry.prepare(nextParams)
        expect(next.unsent?.payload).toEqual(deniedData.payload)
        const data = { ...value.data, runId: next.run.id, logsFileId: next.logsFileId, payload: next.unsent!.payload }
        const delivery = { queueName: 'explicit-retry-fixture', jobId: next.run.id, data, queueToken: 'fresh-after-fix-claim' }
        await value.execution.prepare({ ...delivery, origin: value.origin })
        const admissionId = await value.execution.admit(delivery)
        expect(await value.execution.start({ ...delivery, admissionId, connectionId: 'fresh-after-fix-worker' })).toBe(true)
        const duplicate = await retry.prepare(nextParams)
        expect(duplicate.run.id).toBe(next.run.id)
        expect(duplicate.enqueue).toBe(false)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ id: grant.id })).consumed).toBe(2n)
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ platformId: value.platformId })).toBe(0)
    })

    it('never silently changes a failed BYOK workflow to managed billing', async () => {
        const value = await failedRoot('byok')
        const oldVersion = await ds.getRepository(FlowVersionEntity).findOneByOrFail({ id: value.flowVersionId })
        const trigger = JSON.parse(JSON.stringify(oldVersion.trigger))
        trigger.nextAction.settings.input = { provider: { provider: 'activepieces' }, model: 'sydekyks' }
        const latestId = apId()
        await ds.getRepository(FlowVersionEntity).insert({ ...oldVersion, id: latestId, trigger })
        await expect(createHostedExplicitRetry({ dataSource: ds }).prepare({ ...value.params, flowVersionId: latestId })).rejects.toThrow('RETRY_PAYER_CHANGED')
    })

    it('rechecks current session and tenant scope before returning even an existing retry', async () => {
        const value = await failedRoot()
        const retry = createHostedExplicitRetry({ dataSource: ds })
        await retry.prepare(value.params)
        await expect(retry.prepare({ ...value.params, origin: { ...value.origin, tokenVersion: 'revoked-token' } })).rejects.toThrow('ACCESS_DENIED')
        await expect(retry.prepare({ ...value.params, projectId: apId() })).rejects.toThrow('PROJECT_ACCESS_DENIED')
    })
})
