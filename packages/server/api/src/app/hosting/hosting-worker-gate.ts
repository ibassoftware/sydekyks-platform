import { serviceModePolicy, WorkerProps } from '@activepieces/shared'
import { hostingConfiguration } from './hosting-configuration'

function isCompatible({ workerProps }: { workerProps?: unknown }): boolean {
    const apiMode = hostingConfiguration.getServiceMode()
    if (apiMode === 'hosted') return false
    const parsed = WorkerProps.safeParse(workerProps ?? {})
    return parsed.success && serviceModePolicy.workerIsCompatible({
        apiMode,
        workerMode: parsed.data.serviceMode,
        accountingProtocol: parsed.data.accountingProtocol,
    })
}

export const hostingWorkerGate = { isCompatible }
