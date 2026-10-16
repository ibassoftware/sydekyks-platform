import { apId, isNil, tryCatch } from '@activepieces/core-utils'
import { ConsumeJobRequest, ConsumeJobResponse, EngineResponseStatus, JobData } from '@activepieces/shared'
import { Worker as BullMQWorker, Job, UnrecoverableError } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'
import { accessTokenManager } from '../../authentication/lib/access-token-manager'
import { redisConnections } from '../../database/redis-connections'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { hostingServices } from '../../hosting/hosting-services'
import { HostingError } from '../../hosting/hosting-transactions'
import { engineResponseWatcher } from '../engine-response-watcher'
import { QueueName } from '../job'
import { jobMigrations } from '../migrations/job-data-migrations'
import { rateLimiterInterceptor } from './interceptors/rate-limiter-interceptor'
import { zombiePollingInterceptor } from './interceptors/zombie-polling-interceptor'
import { jobAssignmentTracker } from './job-assignment-tracker'
import { jobFailureLogger } from './job-failure-logger'
import { InterceptorVerdict, JobInterceptor } from './job-interceptor'
import { callerWaitingForResponse } from './job-queue'
import { createQueueDispatcher, QueueDispatcher } from './queue-dispatcher'

const DRAIN_DELAY_SECONDS = 15
const LOCK_DURATION_MS = 120_000

const interceptors: JobInterceptor[] = [rateLimiterInterceptor, zombiePollingInterceptor]
const workerPromises = new Map<string, Promise<BullMQWorker>>()
const dispatchers = new Map<string, QueueDispatcher>()

function ensureBullMQWorker(queueName: string, log: FastifyBaseLogger): Promise<BullMQWorker> {
    const existing = workerPromises.get(queueName)
    if (existing) return existing

    const promise = createBullMQWorker(queueName, log)
    workerPromises.set(queueName, promise)
    return promise
}

async function createBullMQWorker(queueName: string, log: FastifyBaseLogger): Promise<BullMQWorker> {
    const worker = new BullMQWorker(
        queueName,
        undefined,
        {
            connection: await redisConnections.create(),
            concurrency: 500,
            autorun: false,
            lockDuration: LOCK_DURATION_MS,
            stalledInterval: 30_000,
            maxStalledCount: 3,
            drainDelay: DRAIN_DELAY_SECONDS,
        },
    )
    await worker.waitUntilReady()
    await worker.startStalledCheckTimer()

    worker.on('stalled', (jobId: string) => {
        log.warn({ queueName, job: { id: jobId } }, '[jobBroker] Job stalled — BullMQ will retry automatically')
    })

    log.info({ queueName }, '[jobBroker] BullMQ worker initialized')
    return worker
}

async function fetchJobFromRedis(queueName: string, jobId: string, log: FastifyBaseLogger): Promise<Job | null> {
    const worker = await ensureBullMQWorker(queueName, log)
    const job = await Job.fromId(worker, jobId)
    if (isNil(job)) {
        log.warn({ job: { id: jobId }, queueName }, '[jobBroker] Job not found in Redis')
        return null
    }
    return job
}

function ensureDispatcher(queueName: string, worker: BullMQWorker, log: FastifyBaseLogger): QueueDispatcher {
    const existing = dispatchers.get(queueName)
    if (existing) return existing

    const dispatcher = createQueueDispatcher({
        queueName,
        worker,
        dequeue: tryDequeue,
        onOrphanedJob: returnJobToQueue,
        log,
    })
    dispatchers.set(queueName, dispatcher)
    return dispatcher
}

async function tryDequeue(worker: BullMQWorker, queueName: string, log: FastifyBaseLogger): Promise<ConsumeJobRequest | null> {
    const token = `token-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const job = await worker.getNextJob(token)
    if (isNil(job)) {
        return null  // waiting list empty — drainDelay provided backpressure
    }

    if (job.deferredFailure) {
        await cancelHostedDelivery({ queueName, jobId: job.id ?? job.name })
        log.warn(
            { queueName, job: { id: job.id }, jobName: job.name, deferredFailure: job.deferredFailure },
            '[jobBroker#tryDequeue] Failing job with deferred failure (BullMQ stalled limit exceeded)',
        )
        const deferredError = new UnrecoverableError(job.deferredFailure)
        const { error: failError } = await tryCatch(() => job.moveToFailed(deferredError, token, false))
        if (failError) {
            log.error(
                { queueName, job: { id: job.id }, error: String(failError) },
                '[jobBroker#tryDequeue] Failed to fail deferred-failure job',
            )
        }
        else {
            jobFailureLogger.logJobFailed({ queueName, jobId: job.id, jobType: job.name, error: deferredError, log })
        }
        return tryDequeue(worker, queueName, log)
    }

    log.info({ queueName, job: { id: job.id }, jobName: job.name }, '[jobBroker#tryDequeue] Dequeued job')

    const originalSchemaVersion = (job.data as Record<string, unknown>).schemaVersion
    const migratedData = await jobMigrations(log).apply(job.data)
    const jobId = job.id ?? job.name

    if (migratedData.schemaVersion !== originalSchemaVersion) {
        await job.updateData(migratedData)
    }

    const parseResult = JobData.safeParse(migratedData)
    if (!parseResult.success) {
        await cancelHostedDelivery({ queueName, jobId })
        const issues = parseResult.error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
        const reason = `Job data failed schema validation after migration: ${issues}`
        log.error(
            { queueName, job: { id: jobId, type: migratedData.jobType }, schemaVersion: migratedData.schemaVersion, issues: parseResult.error.issues },
            '[jobBroker#tryDequeue] Failing job with invalid schema as unrecoverable',
        )
        const schemaError = new UnrecoverableError(reason)
        const { error: failError } = await tryCatch(() => job.moveToFailed(schemaError, token, false))
        if (failError) {
            log.error({ queueName, job: { id: jobId }, error: String(failError) }, '[jobBroker#tryDequeue] Failed to fail invalid-schema job')
        }
        else {
            jobFailureLogger.logJobFailed({ queueName, jobId, jobType: migratedData.jobType, error: schemaError, log })
        }
        return tryDequeue(worker, queueName, log)
    }

    const interceptorResult = await runInterceptors({ jobId, jobData: migratedData, job, log })
    if (interceptorResult === 'DISCARD') {
        await cancelHostedDelivery({ queueName, jobId })
        await job.moveToCompleted(null, token, false)
        return tryDequeue(worker, queueName, log)
    }
    if (interceptorResult !== null) {
        await job.moveToDelayed(Date.now() + interceptorResult.delayInMs, token)
        if (interceptorResult.priority !== undefined) {
            await job.changePriority({ priority: interceptorResult.priority })
        }
        return tryDequeue(worker, queueName, log)  // retry getNextJob instead of returning null
    }

    const admission = await tryCatch(async () => hostingConfiguration.getServiceMode() === 'hosted'
        ? hostingServices.execution().admit({ queueName, jobId, data: parseResult.data, queueToken: token })
        : apId())
    if (admission.error) {
        if (!(admission.error instanceof HostingError) || admission.error.message === 'HOSTING_CONCURRENCY_LIMIT') await job.moveToDelayed(Date.now() + 1000, token)
        else await job.moveToFailed(new UnrecoverableError('HOSTING_ADMISSION_DENIED'), token, false)
        for (const interceptor of interceptors) await interceptor.onJobFinished({ jobId, jobData: parseResult.data, failed: true, log })
        return tryDequeue(worker, queueName, log)
    }
    const admissionId = admission.data
    const engineToken = await accessTokenManager(log).generateEngineToken({
        jobId: admissionId,
        projectId: migratedData.projectId as string,
        platformId: migratedData.platformId,
    })

    return {
        admissionId,
        jobId,
        jobData: migratedData,
        attempsStarted: job.attemptsMade,
        lastAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
        engineToken,
        token,
        queueName,
    }
}

async function returnJobToQueue(jobId: string, token: string, queueName: string, log: FastifyBaseLogger): Promise<void> {
    const job = await fetchJobFromRedis(queueName, jobId, log)
    if (isNil(job)) {
        return
    }
    const jobData = JobData.parse(job.data)
    await job.moveToDelayed(Date.now() + 100, token)
    for (const interceptor of interceptors) {
        const { error } = await tryCatch(() => interceptor.onJobFinished({ jobId, jobData, failed: false, log }))
        if (error) {
            log.error({ job: { id: jobId }, error: String(error) }, '[jobBroker#returnJobToQueue] interceptor cleanup failed')
        }
    }
    log.info({ job: { id: jobId } }, '[jobBroker#returnJobToQueue] orphaned job returned to queue')
}

async function runInterceptors({ jobId, jobData, job, log }: { jobId: string, jobData: JobData, job: Job, log: FastifyBaseLogger }): Promise<{ delayInMs: number, priority?: number } | 'DISCARD' | null> {
    const passed: JobInterceptor[] = []
    for (const interceptor of interceptors) {
        const result = await interceptor.preDispatch({ jobId, jobData, job, log })
        if (result.verdict === InterceptorVerdict.DISCARD) {
            for (const passedInterceptor of passed) {
                const { error } = await tryCatch(() => passedInterceptor.onJobFinished({ jobId, jobData, failed: false, log }))
                if (error) {
                    log.error({ job: { id: jobId }, error: String(error) }, '[jobBroker] Failed to clean up interceptor on discard')
                }
            }
            return 'DISCARD'
        }
        if (result.verdict === InterceptorVerdict.REJECT) {
            for (const passedInterceptor of passed) {
                const { error } = await tryCatch(() => passedInterceptor.onJobFinished({ jobId, jobData, failed: false, log }))
                if (error) {
                    log.error({ job: { id: jobId }, error: String(error) }, '[jobBroker] Failed to clean up interceptor on reject')
                }
            }
            return { delayInMs: result.delayInMs, priority: result.priority }
        }
        passed.push(interceptor)
    }
    return null
}

async function cancelHostedDelivery({ queueName, jobId }: { queueName: string, jobId: string }): Promise<void> {
    if (hostingConfiguration.getServiceMode() === 'hosted') await hostingServices.execution().cancel({ queueName, jobId, allowMissing: true })
}

function buildFailedReason(errorMessage: string, logs?: string): string {
    if (!logs) return errorMessage
    return `${errorMessage}\n${logs}`
}

export { tryDequeue }

export const jobBroker = (log: FastifyBaseLogger) => ({
    async init(): Promise<void> {
        await ensureBullMQWorker(QueueName.WORKER_JOBS, log)
        log.info('[jobBroker] Job broker initialized')
    },

    async poll(queueName: string = QueueName.WORKER_JOBS, connectionId?: string): Promise<ConsumeJobRequest | null> {
        if (hostingConfiguration.getServiceMode() === 'hosted' && !connectionId) return null
        const worker = await ensureBullMQWorker(queueName, log)
        const dispatcher = ensureDispatcher(queueName, worker, log)
        const job = await dispatcher.poll()
        if (!isNil(job) && !isNil(connectionId)) {
            jobAssignmentTracker.record({ connectionId, jobId: job.jobId, token: job.token, queueName: job.queueName, admissionId: job.admissionId })
        }
        return job
    },

    async startJob(input: { jobId: string, token: string, queueName: string }, connectionId: string): Promise<boolean> {
        if (!jobAssignmentTracker.belongsTo({ ...input, connectionId })) return false
        const assignment = jobAssignmentTracker.assignmentFor(input)
        if (!assignment?.admissionId) return false
        if (hostingConfiguration.getServiceMode() === 'hosted') {
            const job = await fetchJobFromRedis(input.queueName, input.jobId, log)
            if (!job || await job.extendLock(input.token, LOCK_DURATION_MS) <= 0) return false
            const parsed = JobData.safeParse(job.data)
            if (!parsed.success) {
                await cancelHostedDelivery(input); return false
            }
            return hostingServices.execution().start({ queueName: input.queueName, jobId: input.jobId, queueToken: input.token, connectionId, admissionId: assignment.admissionId, data: parsed.data })
        }
        return true
    },

    async releaseConnectionJobs(connectionId: string): Promise<void> {
        const jobs = jobAssignmentTracker.takeByConnection(connectionId)
        if (jobs.length === 0) {
            return
        }
        log.info({ connection: { id: connectionId }, jobCount: jobs.length }, '[jobBroker] Worker connection closed with in-flight jobs — returning them to the queue')
        for (const { jobId, token, queueName, admissionId } of jobs) {
            if (hostingConfiguration.getServiceMode() === 'hosted') {
                if (admissionId) await hostingServices.execution().disconnect({ queueName, jobId, admissionId })
                continue
            }
            const { error } = await tryCatch(() => returnJobToQueue(jobId, token, queueName, log))
            if (error) {
                log.error({ connection: { id: connectionId }, job: { id: jobId }, error: String(error) }, '[jobBroker] Failed to return in-flight job on disconnect — leaving for stalled-scan recovery')
            }
        }
    },

    async completeJob(input: ConsumeJobResponse & { jobId: string, token: string, queueName: string }, connectionId?: string): Promise<void> {
        if (!connectionId || !jobAssignmentTracker.belongsTo({ ...input, connectionId })) return
        const assignment = jobAssignmentTracker.assignmentFor(input)
        if (!assignment) return
        const job = await fetchJobFromRedis(input.queueName, input.jobId, log)
        if (isNil(job)) {
            return
        }

        if (hostingConfiguration.getServiceMode() === 'hosted' && !JobData.safeParse(job.data).success) {
            await cancelHostedDelivery(input); return
        }
        const jobData = JobData.parse(job.data)
        if (hostingConfiguration.getServiceMode() === 'hosted') {
            if (!assignment.admissionId || await job.extendLock(input.token, LOCK_DURATION_MS) <= 0) return
            await hostingServices.execution().complete({ queueName: input.queueName, jobId: input.jobId, queueToken: input.token, connectionId, admissionId: assignment.admissionId, status: input.status })
        }
        const waitingCaller = callerWaitingForResponse(jobData)

        let finalized = false
        const { error } = await tryCatch(async () => {
            if (input.status === EngineResponseStatus.INTERNAL_ERROR && hostingConfiguration.getServiceMode() === 'hosted') {
                await job.moveToFailed(new UnrecoverableError('HOSTING_EXECUTION_UNCERTAIN'), input.token, false)
                finalized = true
                return
            }
            if (input.status === EngineResponseStatus.INTERNAL_ERROR) {
                if (waitingCaller) {
                    // User-interaction jobs (piece-metadata extraction, validation, property/auth, trigger
                    // hooks) are synchronous request/response — the caller awaits the result with a timeout.
                    // Return the error to that caller and COMPLETE the job instead of moving it to failed: the
                    // exponential-backoff retry only fires long after the caller has timed out, so it serves no
                    // one and just piles up dead jobs in the failed queue.
                    await engineResponseWatcher(log).publish(waitingCaller.webserverId, waitingCaller.requestId, {
                        status: EngineResponseStatus.INTERNAL_ERROR,
                        response: undefined,
                        error: input.errorMessage ?? 'Internal error',
                        logs: input.logs,
                    })
                    await job.moveToCompleted({ response: undefined }, input.token, false)
                    finalized = true
                    return
                }
                const engineErrorMessage = input.errorMessage ?? 'Internal error'
                const engineError = new Error(buildFailedReason(engineErrorMessage, input.logs))
                await job.moveToFailed(engineError, input.token)
                finalized = true
                if ((job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)) {
                    jobFailureLogger.logJobFailed({
                        queueName: input.queueName,
                        jobId: input.jobId,
                        jobType: jobData.jobType,
                        error: engineError,
                        log,
                        signatureOverride: jobFailureLogger.signatureFromMessage(engineErrorMessage, 'EngineError'),
                    })
                }
                return
            }

            await job.moveToCompleted({ response: input.response ?? undefined }, input.token, false)
            finalized = true
            if (waitingCaller) {
                await engineResponseWatcher(log).publish(waitingCaller.webserverId, waitingCaller.requestId, {
                    status: input.status,
                    response: input.response,
                    error: input.errorMessage,
                    logs: input.logs,
                })
            }
        })
        if (error) {
            log.error({ job: { id: input.jobId }, error: String(error), originalError: input.errorMessage }, '[jobBroker] Failed to move job to final state — leaving for stalled-scan recovery')
            if (waitingCaller) {
                await engineResponseWatcher(log).publish(waitingCaller.webserverId, waitingCaller.requestId, {
                    status: EngineResponseStatus.INTERNAL_ERROR,
                    response: undefined,
                    error: String(error),
                })
            }
        }

        if (!finalized) return
        jobAssignmentTracker.clearIfMatching({ ...input, connectionId })

        const failed = input.status === EngineResponseStatus.INTERNAL_ERROR || !isNil(error)
        for (const interceptor of interceptors) {
            const { error: interceptorError } = await tryCatch(() => interceptor.onJobFinished({ jobId: input.jobId, jobData, failed, log }))
            if (interceptorError) {
                log.error({ job: { id: input.jobId }, error: String(interceptorError) }, '[jobBroker] Interceptor onJobFinished failed')
            }
        }
    },

    async extendLock(input: { jobId: string, token: string, queueName: string }): Promise<void> {
        const job = await fetchJobFromRedis(input.queueName, input.jobId, log)
        if (isNil(job)) {
            return
        }
        const extended = await job.extendLock(input.token, LOCK_DURATION_MS)
        if (extended > 0 && hostingConfiguration.getServiceMode() === 'hosted') {
            const assignment = jobAssignmentTracker.assignmentFor(input)
            if (assignment?.admissionId) await hostingServices.execution().heartbeat({ queueName: input.queueName, jobId: input.jobId, queueToken: input.token, admissionId: assignment.admissionId })
        }
        log.debug({ job: { id: input.jobId } }, '[jobBroker] Lock extended')
    },

    async close(): Promise<void> {
        for (const dispatcher of dispatchers.values()) {
            dispatcher.close()
        }
        dispatchers.clear()

        const workers = await Promise.allSettled([...workerPromises.values()])
        await Promise.allSettled(
            workers
                .filter((r): r is PromiseFulfilledResult<BullMQWorker> => r.status === 'fulfilled')
                .map(r => r.value.close()),
        )
        workerPromises.clear()
    },
})
