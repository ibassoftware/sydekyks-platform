import { apVersionUtil } from '@activepieces/server-utils'
import { HOSTED_RUNTIME_CAPABILITIES, HOSTED_RUNTIME_PROFILE, RunEnvironment, StreamStepProgress, WorkerJobType, WorkerProps } from '@activepieces/shared'
import fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callback, version, flow, start, dedupe, save, disable } = vi.hoisted(() => ({ callback: vi.fn(), version: vi.fn(), flow: vi.fn(), start: vi.fn(), dedupe: vi.fn(), save: vi.fn(), disable: vi.fn() }))
vi.mock('../../src/app/hosting/hosting-services', () => ({ hostingServices: { execution: () => ({ assertTriggerCallback: callback }) } }))
vi.mock('../../src/app/flows/flow-version/flow-version.service', () => ({ flowVersionService: () => ({ getOne: version }) }))
vi.mock('../../src/app/flows/flow/flow.service', () => ({ flowService: () => ({ getOne: flow }) }))
vi.mock('../../src/app/flows/flow-run/flow-run-service', () => ({ flowRunService: () => ({ start }) }))
vi.mock('../../src/app/project/project-service', () => ({ projectService: () => ({ getPlatformId: async () => 'platform' }) }))
vi.mock('../../src/app/trigger/dedupe-service', () => ({ dedupeService: { filterUniquePayloads: dedupe } }))
vi.mock('../../src/app/trigger/trigger-events/trigger-event.service', () => ({ triggerEventService: () => ({ saveEvent: save }) }))
vi.mock('../../src/app/trigger/trigger-source/trigger-source-service', () => ({ triggerSourceService: () => ({ disable }) }))
vi.mock('../../src/app/platform/billing-provider', () => ({ shouldBlockRunOnCredits: async () => false }))

import { createHandlers } from '../../src/app/workers/rpc/worker-rpc-service'
const log = fastify().log
function rpc() {
    const props: WorkerProps = { serviceMode: 'hosted', accountingProtocol: 1, runtimeProfile: HOSTED_RUNTIME_PROFILE, capabilities: [...HOSTED_RUNTIME_CAPABILITIES], version: apVersionUtil.getCurrentRelease(), EXECUTION_MODE: 'SANDBOX_CODE_ONLY' }
    return createHandlers(log, null, 'socket', props)
}
const input = { admissionId: 'admission', flowVersionId: 'version', projectId: 'project', payloads: [{ id: 1 }], environment: RunEnvironment.PRODUCTION, streamStepProgress: StreamStepProgress.NONE }
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    callback.mockResolvedValue({ jobType: WorkerJobType.EXECUTE_POLLING, flowId: 'flow' })
    version.mockResolvedValue({ id: 'version', flowId: 'flow', trigger: { settings: { pieceName: 'piece' } } })
    flow.mockResolvedValue({ id: 'flow', status: 'ENABLED', publishedVersionId: 'version' })
    dedupe.mockImplementation(async (_version, payloads) => payloads)
    start.mockResolvedValue({ id: 'run' })
    save.mockResolvedValue(undefined); disable.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())
describe('hosted trigger worker callbacks', () => {
    it('requires the running connection and persisted trigger fence before dedupe or flow creation', async () => {
        callback.mockRejectedValueOnce(new Error('HOSTING_DISPATCH_FENCE_MISMATCH'))
        await expect(rpc().submitPayloads(input)).rejects.toThrow('HOSTING_DISPATCH_FENCE_MISMATCH')
        expect(callback).toHaveBeenCalledWith({ admissionId: 'admission', connectionId: 'socket', projectId: 'project', flowVersionId: 'version' })
        expect(dedupe).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
    })
    it('starts every accepted payload under scheduled paid flow admission', async () => {
        expect(await rpc().submitPayloads(input)).toEqual([{ id: 'run' }])
        expect(start).toHaveBeenCalledWith(expect.objectContaining({ hostedOrigin: { type: 'scheduled' }, projectId: 'project', flowId: 'flow', flowVersionId: 'version', executeTrigger: false }))
    })
    it('fences post-disable and old-version callbacks before mutating dedupe state', async () => {
        flow.mockResolvedValueOnce({ status: 'DISABLED', publishedVersionId: 'version' })
        await expect(rpc().submitPayloads(input)).rejects.toThrow('HOSTING_TRIGGER_SCOPE_MISMATCH')
        flow.mockResolvedValueOnce({ status: 'ENABLED', publishedVersionId: 'new-version' })
        await expect(rpc().submitPayloads(input)).rejects.toThrow('HOSTING_TRIGGER_SCOPE_MISMATCH')
        expect(dedupe).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
    })
    it('saves fenced samples before sharing the parent root with cleanup lifecycle', async () => {
        callback.mockResolvedValueOnce({ jobType: WorkerJobType.EXECUTE_WEBHOOK, flowId: 'flow' })
        await rpc().savePayloads({ ...input, flowId: 'flow' })
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'sample', connectionId: 'socket' }))
        expect(save).toHaveBeenCalledWith({ flowId: 'flow', projectId: 'project', payload: { id: 1 } })
        expect(disable).toHaveBeenCalledWith(expect.objectContaining({ simulate: true, hostedOrigin: { type: 'trigger-lifecycle', admissionId: 'admission' } }))
        expect(save.mock.invocationCallOrder[0]).toBeLessThan(disable.mock.invocationCallOrder[0])
    })
    it('rejects forged sample flow IDs without saving or disabling another source', async () => {
        await expect(rpc().savePayloads({ ...input, flowId: 'other-flow' })).rejects.toThrow('HOSTING_TRIGGER_SCOPE_MISMATCH')
        expect(save).not.toHaveBeenCalled(); expect(disable).not.toHaveBeenCalled()
    })
})
