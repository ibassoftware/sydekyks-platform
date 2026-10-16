import { FlowRunStatus } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { databaseConnection } from '../database/database-connection'
import { resumeService } from '../waitpoints/resume-service'
import { WaitpointEntity } from '../waitpoints/waitpoint-entity'
import { WaitpointStatus } from '../waitpoints/waitpoint-types'
import { jobQueue } from '../workers/job-queue/job-queue'
import { hostingConfiguration } from './hosting-configuration'
import { hostingServices } from './hosting-services'
import { HostingError, hostingFail } from './hosting-transactions'

export const hostingRecovery = (log: FastifyBaseLogger) => ({
    async run(): Promise<void> {
        if (hostingConfiguration.getServiceMode() !== 'hosted') hostingFail('HOSTED_INSTALLATION_REQUIRED')
        await hostingServices.gateway().recover()
        await hostingServices.execution().recover({ publish: async dispatch => {
            if (!dispatch.queueName || !dispatch.jobId || !dispatch.payload) return
            const queue = await jobQueue(log).getOrCreateQueue({ queueName: dispatch.queueName })
            const existing = await queue.getJob(dispatch.jobId)
            if (existing) {
                const state = await existing.getState()
                if (state === 'failed') await existing.retry()
                return
            }
            await queue.add(dispatch.jobId, dispatch.payload, { jobId: dispatch.jobId, attempts: 1, removeOnComplete: true })
        } })
        const signals = await databaseConnection().getRepository(WaitpointEntity).createQueryBuilder('waitpoint')
            .innerJoin('hosting_dispatch', 'dispatch', 'dispatch.id = waitpoint."hostingDispatchId" AND dispatch."waitpointId" = waitpoint.id')
            .innerJoin('flow_run', 'run', 'run.id = waitpoint."flowRunId" AND run."projectId" = waitpoint."projectId"')
            .where('waitpoint.status = :status AND run.status = :paused AND NOT EXISTS (SELECT 1 FROM hosting_dispatch newer WHERE newer."platformId" = dispatch."platformId" AND newer."flowRunId" = dispatch."flowRunId" AND newer.generation > dispatch.generation)', { status: WaitpointStatus.COMPLETED, paused: FlowRunStatus.PAUSED })
            .orderBy('waitpoint.updated', 'ASC').addOrderBy('waitpoint.id', 'ASC').take(50).getMany()
        for (const signal of signals) {
            try {
                await resumeService(log).resumeTrusted({ flowRunId: signal.flowRunId, waitpointId: signal.id, resumePayload: signal.resumePayload })
            }
            catch (error) {
                if (!(error instanceof HostingError)) throw error
                log.warn({ reason: error.message, waitpointId: signal.id }, '[hostingRecovery] Resume remains blocked')
            }
            finally {
                await databaseConnection().getRepository(WaitpointEntity).update({ id: signal.id, status: WaitpointStatus.COMPLETED }, { updated: new Date().toISOString() })
            }
        }
    },
})
