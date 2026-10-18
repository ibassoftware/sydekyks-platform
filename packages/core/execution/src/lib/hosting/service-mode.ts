import { z } from 'zod'

function resolve({ value }: { value?: string }): ServiceMode {
    if (value === undefined) return 'self_hosted'
    const parsed = ServiceMode.safeParse(value)
    if (!parsed.success) throw new Error('AP_SERVICE_MODE must be self_hosted or hosted')
    return parsed.data
}

function workerIsCompatible({ apiMode, workerMode, accountingProtocol, runtimeProfile, capabilities }: WorkerCompatibilityParams): boolean {
    if (workerMode === undefined) return apiMode === 'self_hosted'
    if (workerMode !== apiMode) return false
    return apiMode === 'self_hosted' || (accountingProtocol === HOSTED_ACCOUNTING_PROTOCOL && runtimeProfile === HOSTED_RUNTIME_PROFILE && Array.isArray(capabilities) && capabilities.length === HOSTED_RUNTIME_CAPABILITIES.length && HOSTED_RUNTIME_CAPABILITIES.every(capability => capabilities.includes(capability)))
}

function assertWorkerSettings({ localMode, serverMode, accountingProtocol, runtimeProfile, capabilities }: WorkerSettingsParams): void {
    const resolvedServerMode = resolve({ value: serverMode })
    if (!workerIsCompatible({ apiMode: resolvedServerMode, workerMode: localMode, accountingProtocol, runtimeProfile, capabilities })) {
        throw new Error('Worker service mode or hosting accounting protocol does not match the API')
    }
}

export const ServiceMode = z.enum(['self_hosted', 'hosted'])
export type ServiceMode = z.infer<typeof ServiceMode>
export const HOSTED_ACCOUNTING_PROTOCOL = 1
// Exact profile: user-started flows (including AI steps), root chat, durable
// admission/settlement and fenced callbacks. Triggers, MCP and agent tools deny.
export const HOSTED_RUNTIME_PROFILE = 'partner-pilot-v1'
export const HOSTED_RUNTIME_CAPABILITIES = ['flow-admission-v1', 'root-chat-v1', 'ai-hard-cap-v1', 'durable-settlement-v1', 'connection-fencing-v1', 'code-isolation-v1'] as const
export const serviceModePolicy = { resolve, workerIsCompatible, assertWorkerSettings }

type WorkerCompatibilityParams = {
    apiMode: ServiceMode
    workerMode?: unknown
    accountingProtocol?: unknown
    runtimeProfile?: unknown
    capabilities?: unknown
}

type WorkerSettingsParams = {
    localMode: ServiceMode
    serverMode?: string
    accountingProtocol?: number
    runtimeProfile?: string
    capabilities?: string[]
}
