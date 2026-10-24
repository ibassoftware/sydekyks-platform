import { apId } from '@activepieces/core-utils'
import { EngineResponseStatus, FileType, FlowActionType, FlowRunStatus, FlowTrigger, FlowTriggerType, FlowVersionState, JobData, LATEST_FLOW_SCHEMA_VERSION } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderEntity } from '../../src/app/ai/ai-provider-entity'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { FileEntity } from '../../src/app/file/file.entity'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { FlowEntity } from '../../src/app/flows/flow/flow.entity'
import { FlowRunEntity } from '../../src/app/flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../../src/app/flows/flow-version/flow-version-entity'
import { encryptUtils } from '../../src/app/helper/encryption'
import { HostingDispatchEntity } from '../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingReservationEntity } from '../../src/app/hosting/hosting-entities'
import { createHostedExecution } from '../../src/app/hosting/hosting-execution'
import { INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'
import { HostingModelCallEntity } from '../../src/app/hosting/hosting-model-call-entity'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'
import { WebhookFlowVersionToRun, webhookService } from '../../src/app/webhooks/webhook.service'
import { bootstrapHostedOperator, migratedHostedPGlite } from '../helpers/hosting-fixtures'

const state = vi.hoisted(() => ({ add: vi.fn(), onStart: vi.fn(), current: null as null | { flowId: string, platformId: string } }))
vi.mock('../../src/app/workers/job-queue/job-queue', () => ({ JobType: { ONE_TIME: 'ONE_TIME' }, jobQueue: () => ({ add: state.add }) }))
vi.mock('../../src/app/flows/flow-run/flow-run-side-effects', () => ({ flowRunSideEffects: () => ({ onStart: state.onStart }) }))
vi.mock('../../src/app/platform/billing-provider', async importOriginal => ({ ...await importOriginal<typeof import('../../src/app/platform/billing-provider')>(), shouldBlockRunOnCredits: async () => false }))
vi.mock('../../src/app/workers/payload-offloader', () => ({ payloadOffloader: { getPayloadSizeInBytes: (payload: unknown) => Buffer.byteLength(JSON.stringify(payload)), offloadPayload: async (_log: unknown, payload: unknown) => ({ type: 'inline', value: payload }), maybeOffloadPayload: async (_log: unknown, payload: unknown) => ({ type: 'inline', value: payload }) } }))
vi.mock('../../src/app/flows/flow/flow-execution-cache', () => ({ flowExecutionCache: () => ({ get: async () => ({ exists: true, platformId: state.current!.platformId, flow: await ds.getRepository(FlowEntity).findOneByOrFail({ id: state.current!.flowId }) }) }) }))

let ds: DataSource, previousConnection: unknown, previousAllowlist: string | undefined
let execution: ReturnType<typeof createHostedExecution>
const deliveries: Array<{ queueName: string, jobId: string, data: JobData }> = []
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } as never
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    previousAllowlist = process.env.AP_HOSTED_OPERATOR_IDENTITY_IDS
    ds = await migratedHostedPGlite()
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    execution = createHostedExecution({ dataSource: ds })
})
afterAll(async () => {
    if (previousAllowlist === undefined) delete process.env.AP_HOSTED_OPERATOR_IDENTITY_IDS
    else process.env.AP_HOSTED_OPERATOR_IDENTITY_IDS = previousAllowlist
    vi.unstubAllEnvs()
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds?.isInitialized) await ds.destroy()
})
beforeEach(() => {
    deliveries.length = 0
    vi.clearAllMocks()
    state.add.mockImplementation(async params => {
        const delivery = { queueName: 'authenticated-draft-fixture', jobId: params.id, data: params.data as JobData }
        await execution.prepare({ ...delivery, origin: params.hostedOrigin })
        deliveries.push(delivery)
    })
})
async function fixture(payer: 'managed' | 'byok' = 'managed') {
    const identityId = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id: identityId, email: `${identityId}@example.com`.toLowerCase(), provider: 'EMAIL', password: 'unused', verified: true, firstName: 'Test', lastName: 'Owner' })
    const tenant = await bootstrapHostedOperator(ds, createHostedOnboarding({ dataSource: ds, subjectSecret: 'synthetic-draft-secret-at-least-32-characters' }), identityId)
    if (!tenant.projectId) throw new Error('Missing project')
    const flowId = apId(), versionId = apId(), configId = apId()
    if (payer === 'byok') await ds.getRepository(AIProviderEntity).insert({ id: configId, platformId: tenant.platformId, provider: 'deepseek', displayName: 'Synthetic client-owned key', auth: await encryptUtils.encryptObject({ apiKey: 'synthetic-byok-draft-not-a-live-key' }), config: {}, status: 'active', enabledForChat: false, projectScope: 'all', projectIds: [], modelScope: 'all', modelIds: [], statusVersion: 0 })
    await ds.getRepository(FlowEntity).insert({ id: flowId, projectId: tenant.projectId, externalId: apId() })
    const trigger = { name: 'trigger', type: FlowTriggerType.PIECE, displayName: 'Form', valid: true, settings: { pieceName: '@activepieces/piece-forms', pieceVersion: '0.4.1', triggerName: 'form_submission', input: {}, propertySettings: {} }, nextAction: { name: 'ai', type: FlowActionType.PIECE, settings: { pieceName: '@activepieces/piece-ai', pieceVersion: '0.0.1', actionName: 'askAi', input: { provider: payer === 'byok' ? { provider: 'deepseek', configId } : { provider: 'activepieces' }, model: payer === 'byok' ? 'deepseek-flash' : 'sydekyks' } } } } as unknown as FlowTrigger
    await ds.getRepository(FlowVersionEntity).insert({ id: versionId, flowId, displayName: 'Private draft', schemaVersion: LATEST_FLOW_SCHEMA_VERSION, trigger, connectionIds: [], agentIds: [], valid: true, state: FlowVersionState.DRAFT, notes: [] })
    state.current = { flowId, platformId: tenant.platformId }
    const actor = { userId: tenant.userId, tokenVersion: tenant.tokenVersion, projectId: tenant.projectId, platformId: tenant.platformId }
    const request = { flowId, async: true, saveSampleData: true, flowVersionToRun: WebhookFlowVersionToRun.LATEST, data: async () => ({ body: { resumeText: 'Synthetic text input' }, headers: {}, queryParams: {}, method: 'POST' }), logger: log, execute: true, failParentOnFailure: false, hostedDraftActor: actor }
    return { tenant, flowId, actor, request }
}
describe('hosted Form draft uses ordinary durable admission', () => {
    for (const payer of ['managed', 'byok'] as const) it(`records the authenticated ${payer} payer once and settles one Credit without a capture root`, async () => {
        const value = await fixture(payer)
        const response = await webhookService.handleWebhook(value.request)
        expect(response.status).toBe(200)
        expect(state.add).toHaveBeenCalledOnce()
        expect(deliveries).toHaveLength(1)
        const delivery = deliveries[0]
        const run = await ds.getRepository(FlowRunEntity).findOneByOrFail({ id: delivery.jobId })
        expect(run.triggeredBy).toBe(value.tenant.userId)
        expect(run.environment).toBe('TESTING')
        const admissionId = await execution.admit({ ...delivery, queueToken: 'test-lock' })
        const fence = { queueName: delivery.queueName, jobId: delivery.jobId, queueToken: 'test-lock', connectionId: 'synthetic-worker', admissionId }
        expect(await execution.start({ ...delivery, ...fence })).toBe(true)
        await ds.getRepository(FileEntity).insert({ id: (delivery.data as { logsFileId: string }).logsFileId, platformId: value.tenant.platformId, projectId: value.tenant.projectId!, type: FileType.FLOW_RUN_LOG, location: 'DB', data: Buffer.from('{}') })
        await execution.flowReceipt({ admissionId, projectId: value.actor.projectId, runId: run.id, status: FlowRunStatus.SUCCEEDED })
        await execution.complete({ ...fence, status: EngineResponseStatus.OK })
        await execution.complete({ ...fence, status: EngineResponseStatus.OK })
        const roots = await ds.getRepository(HostingReservationEntity).findBy({ platformId: value.tenant.platformId, kind: 'execution' })
        expect(roots).toHaveLength(1)
        expect(roots[0]).toMatchObject({ payer, state: 'settled', actualAmount: 1n })
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ platformId: value.tenant.platformId })).toBe(0)
        expect(await ds.getRepository(HostingDispatchEntity).countBy({ platformId: value.tenant.platformId })).toBe(1)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.tenant.platformId })).activeExecutions).toBe(0)
    })
    it('cannot admit or create supplier work with an exhausted grant', async () => {
        const value = await fixture()
        await webhookService.handleWebhook(value.request)
        await ds.query('UPDATE hosting_grant SET consumed=amount WHERE "platformId"=$1', [value.tenant.platformId])
        const delivery = deliveries[0]
        await expect(execution.admit({ ...delivery, queueToken: 'no-credits' })).rejects.toThrow('HOSTING_CREDITS_EXHAUSTED')
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.tenant.platformId })).toBe(0)
        expect(await ds.getRepository(HostingModelCallEntity).countBy({ platformId: value.tenant.platformId })).toBe(0)
        expect(state.add).toHaveBeenCalledOnce()
    })
    it('returns a confirmed expired-access refusal rather than a stale queued result', async () => {
        const value = await fixture()
        await ds.getRepository(HostingAccountEntity).update({ id: value.tenant.platformId }, { status: 'suspended' })
        const response = await webhookService.handleWebhook(value.request)
        expect(response.status).toBe(402)
        expect(deliveries).toHaveLength(0)
        expect(await ds.getRepository(HostingDispatchEntity).countBy({ platformId: value.tenant.platformId })).toBe(0)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.tenant.platformId })).toBe(0)
        expect(state.onStart).not.toHaveBeenCalled()
    })
})
