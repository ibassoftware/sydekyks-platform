import { EngineResponseStatus, JobData, TriggerHookType, WorkerJobType } from '@activepieces/shared'

// Classification uses the server-persisted job, never a client billing flag.
export function isHostedMaintenanceJob(data: JobData): boolean {
    return [WorkerJobType.EXECUTE_PROPERTY, WorkerJobType.EXECUTE_VALIDATION, WorkerJobType.EXECUTE_RESOLVE_CONNECTION_IDENTIFIER, WorkerJobType.EXECUTE_TOKEN_REFRESH, WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION].includes(data.jobType)
}

export const HOSTED_COORDINATOR_JOB_TYPES: WorkerJobType[] = [WorkerJobType.EXECUTE_PROPERTY, WorkerJobType.EXECUTE_VALIDATION, WorkerJobType.EXECUTE_RESOLVE_CONNECTION_IDENTIFIER, WorkerJobType.EXECUTE_TOKEN_REFRESH, WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION, WorkerJobType.EXECUTE_TRIGGER_HOOK, WorkerJobType.EXECUTE_POLLING, WorkerJobType.RENEW_WEBHOOK, WorkerJobType.EXECUTE_WEBHOOK]

export function isHostedCoordinatorJob(data: JobData): boolean {
    return HOSTED_COORDINATOR_JOB_TYPES.includes(data.jobType)
}

export function isHostedTestTrigger(data: JobData): boolean {
    return data.jobType === WorkerJobType.EXECUTE_TRIGGER_HOOK && data.hookType === TriggerHookType.TEST
}

export function hasDefinitiveHostedCompletion(data: JobData | null, status: EngineResponseStatus | null): boolean {
    if (!status || status === EngineResponseStatus.INTERNAL_ERROR) return false
    return !data || !isHostedCoordinatorJob(data) || status === EngineResponseStatus.OK || status === EngineResponseStatus.USER_FAILURE
}
