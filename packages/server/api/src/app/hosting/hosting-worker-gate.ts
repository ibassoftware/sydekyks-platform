import { apVersionUtil, UNKNOWN_VERSION } from '@activepieces/server-utils'
import { serviceModePolicy, WorkerProps } from '@activepieces/shared'
import { hostingConfiguration } from './hosting-configuration'

function isCompatible({ workerProps }: { workerProps?: unknown }): boolean {
    const apiMode = hostingConfiguration.getServiceMode()
    const parsed = WorkerProps.safeParse(workerProps ?? {})
    if (!parsed.success) return false
    const props = parsed.data
    if (apiMode === 'hosted') {
        const release = apVersionUtil.getCurrentRelease()
        if (release === UNKNOWN_VERSION || props.version !== release || props.EXECUTION_MODE !== 'SANDBOX_CODE_ONLY') return false
    }
    return serviceModePolicy.workerIsCompatible({
        apiMode, workerMode: props.serviceMode, accountingProtocol: props.accountingProtocol,
        runtimeProfile: props.runtimeProfile, capabilities: props.capabilities,
    })
}

export const hostingWorkerGate = { isCompatible }
