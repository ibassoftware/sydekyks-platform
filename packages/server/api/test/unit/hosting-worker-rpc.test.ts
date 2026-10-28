import { apVersionUtil } from '@activepieces/server-utils'
import { HOSTED_RUNTIME_CAPABILITIES, HOSTED_RUNTIME_PROFILE, WorkerMachineHealthcheckRequest, WorkerProps } from '@activepieces/shared'
import fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { poll, start, onConnection } = vi.hoisted(() => ({ poll: vi.fn(), start: vi.fn(), onConnection: vi.fn() }))
vi.mock('../../src/app/workers/job-queue/job-broker', () => ({ jobBroker: () => ({ poll, startJob: start }) }))
vi.mock('../../src/app/workers/machine/machine-service', () => ({ machineService: () => ({ onConnection }) }))

import { createHandlers } from '../../src/app/workers/rpc/worker-rpc-service'

const log = fastify().log
const job = { jobId: 'synthetic-job', token: 'synthetic-admission-token', queueName: 'synthetic-queue' }
const machine = WorkerMachineHealthcheckRequest.parse({
    workerId: 'synthetic-worker', workerProps: {}, cpuUsagePercentage: 0,
    diskInfo: { total: 1, free: 1, used: 0, percentage: 0 },
    ramUsagePercentage: 0, totalAvailableRamInBytes: 1, totalCpuCores: 1, ip: '127.0.0.1',
})

beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
    start.mockResolvedValue(true)
})
afterEach(() => vi.unstubAllEnvs())

describe('connection-bound hosting worker gates', () => {
    it('withholds polling before touching queues or capacity for a mismatched connection', async () => {
        const rpc = createHandlers(log, null, 'socket-a', { serviceMode: 'hosted', accountingProtocol: 1 })
        await expect(rpc.poll(machine)).resolves.toBeNull()
        expect(poll).not.toHaveBeenCalled()
        expect(onConnection).not.toHaveBeenCalled()
    })

    it('cannot replace a connection declaration with new polling metadata', async () => {
        const rpc = createHandlers(log, null, 'socket-a', { serviceMode: 'self_hosted' })
        await expect(rpc.poll({ ...machine, workerProps: { serviceMode: 'hosted', accountingProtocol: 1 } })).resolves.toBeNull()
        expect(poll).not.toHaveBeenCalled()
    })

    it('keeps the authenticated connection declaration immutable for job start', async () => {
        const props: WorkerProps = { serviceMode: 'hosted', accountingProtocol: 1 }
        const rpc = createHandlers(log, null, 'socket-a', props)
        props.serviceMode = 'self_hosted'
        await expect(rpc.startJob(job)).resolves.toBe(false)
        expect(start).not.toHaveBeenCalled()
    })

    it('preserves old self-hosted starts and binds them to the broker connection', async () => {
        await expect(createHandlers(log, null, 'socket-a').startJob(job)).resolves.toBe(true)
        expect(start).toHaveBeenCalledWith(job, 'socket-a')
        await expect(createHandlers(log).startJob(job)).resolves.toBe(false)
        expect(start).toHaveBeenCalledTimes(1)
    })

    it('admits the exact pilot declaration and fences a revoked connection', async () => {
        vi.stubEnv('AP_SERVICE_MODE', 'hosted')
        const props: WorkerProps = { serviceMode: 'hosted', accountingProtocol: 1, runtimeProfile: HOSTED_RUNTIME_PROFILE, capabilities: [...HOSTED_RUNTIME_CAPABILITIES], version: apVersionUtil.getCurrentRelease(), EXECUTION_MODE: 'SANDBOX_CODE_ONLY' }
        const abort = new AbortController()
        const rpc = createHandlers(log, null, 'socket-pilot', props, abort.signal)
        await expect(rpc.startJob(job)).resolves.toBe(true)
        expect(start).toHaveBeenCalledWith(job, 'socket-pilot')
        abort.abort()
        await expect(rpc.startJob(job)).resolves.toBe(false)
        expect(start).toHaveBeenCalledTimes(1)
    })

    it('polls independent hosted tool and refresh lanes with the same connection fence', async () => {
        vi.stubEnv('AP_SERVICE_MODE', 'hosted')
        const props: WorkerProps = { serviceMode: 'hosted', accountingProtocol: 1, runtimeProfile: HOSTED_RUNTIME_PROFILE, capabilities: [...HOSTED_RUNTIME_CAPABILITIES], version: apVersionUtil.getCurrentRelease(), EXECUTION_MODE: 'SANDBOX_CODE_ONLY' }
        const rpc = createHandlers(log, null, 'socket-lanes', props)
        for (const hostedLane of ['tools', 'refresh'] as const) {
            await rpc.poll({ ...machine, workerProps: props, hostedLane })
            expect(poll).toHaveBeenLastCalledWith(`workerJobs-${hostedLane}`, 'socket-lanes', undefined)
        }
        await rpc.poll({ ...machine, workerProps: props })
        expect(poll).toHaveBeenLastCalledWith('workerJobs', 'socket-lanes', undefined)
    })

    it('does not permit hosted start or prewarming even with claimed protocol support', async () => {
        vi.stubEnv('AP_SERVICE_MODE', 'hosted')
        const rpc = createHandlers(log, null, 'socket-a', { serviceMode: 'hosted', accountingProtocol: 1 })
        await expect(rpc.startJob(job)).resolves.toBe(false)
        const prewarm = await rpc.getPrewarmData({ workerGroupId: undefined, projectWorker: undefined })
        expect(prewarm.engineToken).toBe('')
        expect(prewarm.pieces).toEqual([])
        expect(prewarm.codes).toEqual([])
        await expect(rpc.getPrewarmScopeFile({ fileId: 'synthetic-file' })).resolves.toBeNull()
        expect(start).not.toHaveBeenCalled()
    })
})
