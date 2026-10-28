import { ExecutionType, LATEST_JOB_DATA_SCHEMA_VERSION, RunEnvironment, StreamStepProgress, WorkerJobType } from '@activepieces/shared'
import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { add, execution, createRedis, workerGroup } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue({ id: 'queued-self-hosted-run' }), execution: vi.fn(() => { throw new Error('HOSTED_LEDGER_MUST_NOT_BE_USED') }), createRedis: vi.fn().mockResolvedValue({}), workerGroup: { isWorkerGroupsEnabled: vi.fn().mockResolvedValue(false), getWorkerGroupId: vi.fn().mockResolvedValue(null) } }))
vi.mock('bullmq', () => ({ Queue: class {
    add = add
    removeGlobalConcurrency = vi.fn().mockResolvedValue(undefined)
    waitUntilReady = vi.fn().mockResolvedValue(undefined)
} }))
vi.mock('../../src/app/database/redis-connections', () => ({ redisConnections: { create: createRedis } }))
vi.mock('../../src/app/hosting/hosting-services', () => ({ hostingServices: { execution } }))
vi.mock('../../src/app/hosting/hosting-recovery', () => ({ hostingRecovery: vi.fn() }))
vi.mock('../../src/app/sydekyks-community/shared-worker-routing', () => ({ workerGroupService: () => workerGroup }))
vi.mock('../../src/app/project/project-worker-group.service', () => ({ projectWorkerGroupService: vi.fn() }))

import { getQueueName, jobQueue, JobType } from '../../src/app/workers/job-queue/job-queue'

afterEach(() => vi.unstubAllEnvs())

describe('default self-hosted execution admission', () => {
    it.each([undefined, 'self_hosted'].flatMap(mode => [RunEnvironment.TESTING, RunEnvironment.PRODUCTION].map(environment => ({ mode, environment }))))('queues ordinary $environment executions with no hosted account, Credits or provider configuration in mode $mode', async ({ mode, environment }) => {
        vi.stubEnv('AP_SERVICE_MODE', mode)
        for (const setting of ['AP_HOSTED_OPERATOR_IDENTITY_IDS', 'AP_HOSTED_DEEPSEEK_API_KEY', 'AP_HOSTED_STRIPE_SECRET_KEY']) vi.stubEnv(setting, undefined)
        add.mockClear(); execution.mockClear()
        const data = { schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, platformId: 'self-hosted-platform', projectId: 'self-hosted-project', flowId: 'self-hosted-flow', flowVersionId: 'self-hosted-version', runId: 'self-hosted-run', jobType: WorkerJobType.EXECUTE_FLOW, executionType: ExecutionType.BEGIN, environment, streamStepProgress: StreamStepProgress.NONE, logsFileId: 'self-hosted-log', payload: { type: 'inline' as const, value: null } }
        await expect(jobQueue(fastify().log).add({ id: data.runId, type: JobType.ONE_TIME, data })).resolves.toEqual({ id: 'queued-self-hosted-run' })
        expect(execution).not.toHaveBeenCalled()
        expect(add).toHaveBeenCalledExactlyOnceWith(data.runId, data, expect.not.objectContaining({ attempts: 1 }))
    })
})


describe('hosted tool queues cannot be occupied by parent chats', () => {
    it.each([WorkerJobType.EXECUTE_PROPERTY, WorkerJobType.EXECUTE_ACTION, WorkerJobType.EXECUTE_VALIDATION, WorkerJobType.EXECUTE_RESOLVE_CONNECTION_IDENTIFIER])('routes %s to tool capacity with a separate refresh dependency', async jobType => {
        vi.stubEnv('AP_SERVICE_MODE', 'hosted')
        const args = { platformId: 'synthetic-platform', projectId: 'synthetic-project' }
        expect(await getQueueName({ ...args, jobType }, fastify().log)).toBe('workerJobs-tools')
        expect(await getQueueName({ ...args, jobType: WorkerJobType.EXECUTE_TOKEN_REFRESH }, fastify().log)).toBe('workerJobs-refresh')
        expect(await getQueueName({ ...args, jobType: WorkerJobType.EXECUTE_AGENT_RUN }, fastify().log)).toBe('workerJobs')
        expect(await getQueueName({ ...args, jobType: WorkerJobType.EXECUTE_FLOW }, fastify().log)).toBe('workerJobs')
        expect(execution).not.toHaveBeenCalled()
    })
    it('leaves self-hosted action/refresh routing unchanged', async () => {
        vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
        for (const jobType of [WorkerJobType.EXECUTE_ACTION, WorkerJobType.EXECUTE_TOKEN_REFRESH]) {
            expect(await getQueueName({ platformId: 'free', projectId: 'free', jobType }, fastify().log)).toBe('workerJobs')
        }
    })
})
