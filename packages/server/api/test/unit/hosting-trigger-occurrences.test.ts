import { FlowTriggerType, LATEST_JOB_DATA_SCHEMA_VERSION, WorkerJobType } from '@activepieces/shared'
import { Job, Worker } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prepare, admit, allow } = vi.hoisted(() => ({ prepare: vi.fn(), admit: vi.fn(), allow: vi.fn() }))
vi.mock('../../src/app/hosting/hosting-configuration', () => ({ hostingConfiguration: { getServiceMode: () => 'hosted' } }))
vi.mock('../../src/app/hosting/hosting-services', () => ({ hostingServices: { execution: () => ({ prepare, admit }) } }))
vi.mock('../../src/app/authentication/lib/access-token-manager', () => ({ accessTokenManager: () => ({ generateEngineToken: vi.fn().mockResolvedValue('engine-token') }) }))
vi.mock('../../src/app/workers/migrations/job-data-migrations', () => ({ jobMigrations: () => ({ apply: async (data: unknown) => data }) }))
vi.mock('../../src/app/workers/job-queue/interceptors/rate-limiter-interceptor', () => ({ rateLimiterInterceptor: { preDispatch: allow, onJobFinished: vi.fn() } }))
vi.mock('../../src/app/workers/job-queue/interceptors/zombie-polling-interceptor', () => ({ zombiePollingInterceptor: { preDispatch: allow, onJobFinished: vi.fn() } }))

import { HostingError } from '../../src/app/hosting/hosting-transactions'
import { tryDequeue } from '../../src/app/workers/job-queue/job-broker'
const data = { platformId: 'platform', projectId: 'project', schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_POLLING, flowId: 'flow', flowVersionId: 'version', triggerType: FlowTriggerType.PIECE }
const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger
function occurrence(id: string): Job {
    return { id, name: 'version', data, opts: { attempts: 1 }, attemptsMade: 0, moveToFailed: vi.fn(), moveToDelayed: vi.fn() } as unknown as Job
}
beforeEach(() => {
    vi.clearAllMocks()
    allow.mockResolvedValue({ verdict: 'ALLOW' })
    prepare.mockResolvedValue(data)
    admit.mockResolvedValue('admission')
})
describe('hosted repeating trigger occurrences', () => {
    it('prepares a separate durable dispatch before admitting each scheduler occurrence', async () => {
        const first = occurrence('repeat-version-1'), second = occurrence('repeat-version-2')
        const worker = { getNextJob: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as unknown as Worker
        await tryDequeue(worker, 'queue', log)
        await tryDequeue(worker, 'queue', log)
        expect(prepare.mock.calls.map(([request]) => request.jobId)).toEqual(['repeat-version-1', 'repeat-version-2'])
        expect(prepare).toHaveBeenCalledWith({ queueName: 'queue', jobId: 'repeat-version-1', data, origin: { type: 'scheduled' } })
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(admit.mock.invocationCallOrder[0])
        expect(admit).toHaveBeenCalledTimes(2)
    })
    it('does not dispatch an occurrence refused after trigger removal or expiry', async () => {
        const job = occurrence('repeat-stale')
        prepare.mockRejectedValueOnce(new HostingError('HOSTING_TRIGGER_SCOPE_MISMATCH'))
        const worker = { getNextJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(null) } as unknown as Worker
        expect(await tryDequeue(worker, 'queue', log)).toBeNull()
        expect(admit).not.toHaveBeenCalled()
        expect(job.moveToFailed).toHaveBeenCalled()
    })
})
