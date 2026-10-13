import { isNil } from '@activepieces/core-utils'

// Tracks which in-flight job each worker CONNECTION holds. The app moves a job to BullMQ `active`
// when a worker polls — BEFORE the worker has received/started it — so a job orphaned by a
// disconnect can be sitting in `active` that the worker itself never saw and could never drain.
// Only the app knows it dispatched that job, so on disconnect the broker reads that connection's
// jobs back from here and returns them to the queue, instead of leaving them in `active` for the
// minutes-long stalled-scan (which is what inflated active past concurrency during deploys).
// A connection's poll / completeJob / disconnect all land on the same app instance, so this
// in-memory map is authoritative for that instance; the stalled-scan backstops an app-instance crash.
//
// Keyed by the per-connection socket id, NOT the stable workerId: a worker keeps the same workerId
// across Socket.IO reconnects, so a late `disconnect` for an old socket — fired after the worker has
// already reconnected and polled fresh jobs — would otherwise reclaim those fresh jobs out from under
// the live connection. Scoping to the socket id means an old socket's disconnect only reclaims its
// own jobs. Assignments themselves are keyed by (queueName, jobId) so the same job id on the shared
// and a worker-group queue can't clobber each other's token.

const assignmentByKey = new Map<string, JobAssignment>()
const keysByConnectionId = new Map<string, Set<string>>()

export const jobAssignmentTracker = {
    record(params: { connectionId: string, jobId: string, token: string, queueName: string, admissionId?: string }): void {
        const { connectionId, jobId, token, queueName, admissionId } = params
        const key = keyOf(queueName, jobId)
        const previous = assignmentByKey.get(key)
        if (previous) {
            const previousKeys = keysByConnectionId.get(previous.connectionId)
            previousKeys?.delete(key)
            if (previousKeys?.size === 0) keysByConnectionId.delete(previous.connectionId)
        }
        assignmentByKey.set(key, { connectionId, jobId, token, queueName, admissionId })
        const existing = keysByConnectionId.get(connectionId)
        if (existing) {
            existing.add(key)
        }
        else {
            keysByConnectionId.set(connectionId, new Set([key]))
        }
    },
    clear(params: { jobId: string, queueName: string, admissionId?: string }): void {
        const key = keyOf(params.queueName, params.jobId)
        const assignment = assignmentByKey.get(key)
        if (isNil(assignment)) {
            return
        }
        assignmentByKey.delete(key)
        const connectionKeys = keysByConnectionId.get(assignment.connectionId)
        if (isNil(connectionKeys)) {
            return
        }
        connectionKeys.delete(key)
        if (connectionKeys.size === 0) {
            keysByConnectionId.delete(assignment.connectionId)
        }
    },
    takeByConnection(connectionId: string): TakenAssignment[] {
        const keys = keysByConnectionId.get(connectionId)
        if (isNil(keys)) {
            return []
        }
        keysByConnectionId.delete(connectionId)
        const taken: TakenAssignment[] = []
        for (const key of keys) {
            const assignment = assignmentByKey.get(key)
            if (isNil(assignment) || assignment.connectionId !== connectionId) {
                continue
            }
            assignmentByKey.delete(key)
            taken.push({ jobId: assignment.jobId, token: assignment.token, queueName: assignment.queueName, ...(assignment.admissionId ? { admissionId: assignment.admissionId } : {}) })
        }
        return taken
    },
    assignmentFor(params: { jobId: string, queueName: string, admissionId?: string }): JobAssignment | undefined {
        return assignmentByKey.get(keyOf(params.queueName, params.jobId))
    },
    clearIfMatching(params: { connectionId: string, jobId: string, token: string, queueName: string, admissionId?: string }): boolean {
        if (!this.belongsTo(params)) return false
        this.clear(params)
        return true
    },
    belongsTo(params: { connectionId: string, jobId: string, token: string, queueName: string, admissionId?: string }): boolean {
        const assignment = assignmentByKey.get(keyOf(params.queueName, params.jobId))
        return assignment?.connectionId === params.connectionId && assignment.token === params.token
    },
    admissionIdsFor(connectionId: string): string[] {
        return [...(keysByConnectionId.get(connectionId) ?? [])].flatMap(key => {
            const assignment = assignmentByKey.get(key)
            return assignment?.connectionId === connectionId && assignment.admissionId ? [assignment.admissionId] : []
        })
    },
    reset(): void {
        assignmentByKey.clear()
        keysByConnectionId.clear()
    },
}

function keyOf(queueName: string, jobId: string): string {
    return `${queueName} ${jobId}`
}

type JobAssignment = { connectionId: string, jobId: string, token: string, queueName: string, admissionId?: string }
type TakenAssignment = { jobId: string, token: string, queueName: string, admissionId?: string }
