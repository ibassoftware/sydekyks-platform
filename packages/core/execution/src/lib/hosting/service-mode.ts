import { z } from 'zod'

function resolve({ value }: { value?: string }): ServiceMode {
    if (value === undefined) return 'self_hosted'
    const parsed = ServiceMode.safeParse(value)
    if (!parsed.success) throw new Error('AP_SERVICE_MODE must be self_hosted or hosted')
    return parsed.data
}

function workerIsCompatible({ apiMode, workerMode, accountingProtocol }: WorkerCompatibilityParams): boolean {
    if (workerMode === undefined) return apiMode === 'self_hosted'
    if (workerMode !== apiMode) return false
    return apiMode === 'self_hosted' || accountingProtocol === HOSTED_ACCOUNTING_PROTOCOL
}

function assertWorkerSettings({ localMode, serverMode, accountingProtocol }: WorkerSettingsParams): void {
    const resolvedServerMode = resolve({ value: serverMode })
    if (!workerIsCompatible({ apiMode: resolvedServerMode, workerMode: localMode, accountingProtocol })) {
        throw new Error('Worker service mode or hosting accounting protocol does not match the API')
    }
}

export const ServiceMode = z.enum(['self_hosted', 'hosted'])
export type ServiceMode = z.infer<typeof ServiceMode>
export const HOSTED_ACCOUNTING_PROTOCOL = 1
export const serviceModePolicy = { resolve, workerIsCompatible, assertWorkerSettings }

type WorkerCompatibilityParams = {
    apiMode: ServiceMode
    workerMode?: unknown
    accountingProtocol?: unknown
}

type WorkerSettingsParams = {
    localMode: ServiceMode
    serverMode?: string
    accountingProtocol?: number
}
