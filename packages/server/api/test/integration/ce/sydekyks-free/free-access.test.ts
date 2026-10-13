import { apId } from '@activepieces/core-utils'
import { ExecutionType, LATEST_JOB_DATA_SCHEMA_VERSION, RunEnvironment, StreamStepProgress, WorkerJobType } from '@activepieces/shared'
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { FlagEntity } from '../../../../src/app/flags/flag.entity'
import { jobBroker } from '../../../../src/app/workers/job-queue/job-broker'
import { jobQueue } from '../../../../src/app/workers/job-queue/job-queue'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
let ctx: TestContext

describe('free Sydekyks access', () => {
    beforeAll(async () => {
        app = await setupTestEnvironment({ fresh: true })
        ctx = await createTestContext(app)
    })

    afterAll(async () => {
        await jobBroker(app.log).close()
        await jobQueue(app.log).close()
        await app.close()
    })

    it.each([null, { entitlement: 'expired', expiresAt: 1 }, { entitlement: 'revoked', revoked: true }, { value: 'malformed legacy record' }])('permits product reads and writes with legacy state %j', async (state) => {
        const flags = databaseConnection().getRepository(FlagEntity)
        await flags.delete({ id: 'SYDEKYKS_LICENSE_V1' })
        if (state) await flags.save({ id: 'SYDEKYKS_LICENSE_V1', value: state })
        const create = await ctx.post('/v1/flows', { displayName: 'Free mission', projectId: ctx.project.id })
        expect(create.statusCode, create.body).toBe(201)
        const list = await ctx.get('/v1/flows', { projectId: ctx.project.id })
        expect(list.statusCode, list.body).toBe(200)
    })

    it('preserves authentication and workspace isolation', async () => {
        const anonymous = await app.inject({ method: 'GET', url: `/api/v1/flows?projectId=${ctx.project.id}` })
        expect([401, 403]).toContain(anonymous.statusCode)
        const outsider = await createTestContext(app)
        const denied = await outsider.get('/v1/flows', { projectId: ctx.project.id })
        expect(denied.statusCode).toBeGreaterThanOrEqual(400)
        expect(denied.statusCode).not.toBe(402)
    })

    it('dispatches without licensing and rejects a different worker or stale assignment', async () => {
        const queue = await jobQueue(app.log).getOrCreateQueue({ queueName: `free-test-${apId()}` })
        const id = apId()
        await queue.add(id, { projectId: ctx.project.id, platformId: ctx.platform.id, jobType: WorkerJobType.EXECUTE_FLOW, executionType: ExecutionType.BEGIN, environment: RunEnvironment.TESTING, schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, flowId: apId(), flowVersionId: apId(), runId: apId(), payload: { type: 'inline', value: null }, streamStepProgress: StreamStepProgress.NONE, logsFileId: apId() }, { jobId: id })
        const job = await jobBroker(app.log).poll(queue.name, 'owner-worker')
        expect(job).not.toBeNull()
        if (!job) throw new Error('Expected a queued job')
        expect(await jobBroker(app.log).startJob(job, 'other-worker')).toBe(false)
        expect(await jobBroker(app.log).startJob(job, 'owner-worker')).toBe(true)
        await jobBroker(app.log).releaseConnectionJobs('owner-worker')
        expect(await jobBroker(app.log).startJob(job, 'owner-worker')).toBe(false)
        await queue.obliterate({ force: true })
    })
})
