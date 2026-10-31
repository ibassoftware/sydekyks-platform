import { AIProviderName, ProjectId, UserId } from '@activepieces/core-utils'
import { ApEdition, AppInstance, AttributionParams, DeploymentConfig, FlowRunStatus, GetDiagnosticsResponse, GetSystemHealthChecksResponse, MachineInformation, RunEnvironment, SignUpMethod, TelemetryEvent, User, UserIdentity } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'

// Product and deployment telemetry are paused until a Sydekyks-owned capture
// plan is approved. Retain these APIs for callers; no collector or SDK is loaded.
export const LICENSE_KEY_EVENTS_FLUSH_BATCH_SIZE = 5_000
export const telemetry = (_log: FastifyBaseLogger) => ({
    identify: async (_params: IdentifyParams): Promise<void> => {},
    identifySignUp: async (_params: IdentifySignUpParams): Promise<void> => {},
    aliasIdentity: async (_params: AliasIdentityParams): Promise<void> => {},
    identifyPlatformGroup: async (_params: IdentifyPlatformGroupParams): Promise<void> => {},
    trackPlatform: async (_params: TrackPlatformParams): Promise<void> => {},
    trackProject: async (_params: TrackProjectParams): Promise<void> => {},
    trackIdentity: async (_params: TrackIdentityParams): Promise<void> => {},
    trackUser: async (_params: TrackUserParams): Promise<void> => {},
})
export function captureLicenseKeyEvent(_params: CaptureLicenseKeyEventParams): void {}
export async function flushLicenseKeyPostHogEvents(): Promise<void> {}
export async function shutdownTelemetry(): Promise<void> {}

const DEDUPE_MAX_ENTRIES = 50_000
const dailyEventDedupe = new Map<string, string>()

function onceToday(key: string): boolean {
    const today = new Date().toISOString().slice(0, 10)
    if (dailyEventDedupe.get(key) === today) {
        return false
    }
    if (dailyEventDedupe.size >= DEDUPE_MAX_ENTRIES) {
        dailyEventDedupe.clear()
    }
    dailyEventDedupe.set(key, today)
    return true
}

export const telemetryDedupe = { onceToday }

export enum LicenseKeyPostHogEvents {
    AI_USAGE_PER_RUN = 'ai_usage_per_run',
    CHAT_MESSAGE = 'chat_message',
    PLATFORM_SETUP_REPORT = 'platform_setup_report',
    TOTAL_RUNS_PER_DAY = 'total_runs_per_day',
}

export type AiUsagePerRunProperties = {
    platformId: string
    projectId: string
    edition: ApEdition
    flowRunId: string
    flowId: string
    status: FlowRunStatus
    environment: RunEnvironment
    messages: number
    toolCalls: number
    breakdown: Array<{ provider: string, model: string, messages: number, toolCalls: number }>
}

export type TotalRunsPerDayProperties = {
    platform_id: string
    active_flows: number
    projects: number
    users: number
    daily_executions: Array<{ date: string, count: number }>
    reported_at: string
}

export type ChatMessageProperties = {
    provider: AIProviderName | null
    model: string | null
    toolsUsed: number
}

/**
 * The setup report carries only what helps us diagnose a customer's problem and anticipate the
 * blast radius of a change we are about to ship — the shape of a deployment (how many app replicas
 * and workers, how big, how configured, what release) rather than anything about the people using
 * it or the work it runs. Host identifiers are deliberately excluded: hostname and worker IP
 * identify a machine without telling us anything we would act on.
 *
 * Before adding a field, check it against both halves of that test. "Would this let us answer a
 * support question, or tell us who a change is about to break?" If neither, it does not belong here.
 */
export type SetupReportApp = Pick<AppInstance, 'cpuCores' | 'ramTotalBytes' | 'diskTotalBytes' | 'diskPercentage' | 'version' | 'eventLoopDelayMs'>

export type SetupReportWorker = Pick<MachineInformation, 'totalCpuCores' | 'totalAvailableRamInBytes' | 'diskInfo' | 'workerProps'>

export type SetupReportHealth = Pick<GetSystemHealthChecksResponse, 'database' | 'release'>

export type SetupReportInfra = Pick<GetDiagnosticsResponse, 'database' | 'redis' | 'storage'>

export type SetupReportConfig = Omit<DeploymentConfig, 's3Endpoint'>

export type SetupReportProperties = {
    platformId: string
    edition: ApEdition
    reportedAt: string
    apps?: SetupReportApp[]
    workers?: SetupReportWorker[]
    workersTotal?: number
    infra?: SetupReportInfra
    config?: SetupReportConfig
    health?: SetupReportHealth
}

export type LicenseKeyEventPayload =
    | { event: LicenseKeyPostHogEvents.AI_USAGE_PER_RUN, properties: AiUsagePerRunProperties }
    | { event: LicenseKeyPostHogEvents.TOTAL_RUNS_PER_DAY, properties: TotalRunsPerDayProperties }
    | { event: LicenseKeyPostHogEvents.CHAT_MESSAGE, properties: ChatMessageProperties }
    | { event: LicenseKeyPostHogEvents.PLATFORM_SETUP_REPORT, properties: SetupReportProperties }

type CaptureLicenseKeyEventParams = { licenseKey: string } & LicenseKeyEventPayload

type IdentifyParams = {
    identity: UserIdentity
    platformId: string
    user?: User
    projectId?: ProjectId
}

type IdentifySignUpParams = {
    userId: UserId
    platformId: string
    method: SignUpMethod
    attribution: AttributionParams | undefined
}

type AliasIdentityParams = {
    identityId: string
    userId: UserId
    platformId: string
}

export type PlatformGroupProperties = {
    name: string
    plan: string | null
    createdAt: string
}

type IdentifyPlatformGroupParams = {
    platformId: string
    properties: PlatformGroupProperties
}

type TrackPlatformParams = {
    platformId: string
    event: TelemetryEvent
}

type TrackProjectParams = {
    projectId: ProjectId
    event: TelemetryEvent
}

type TrackIdentityParams = {
    identityId: string
    platformId: string | null
    event: TelemetryEvent
}

type TrackUserParams = {
    userId: UserId
    platformId: string
    event: TelemetryEvent
}
