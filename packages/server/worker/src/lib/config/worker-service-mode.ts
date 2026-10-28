import { apVersionUtil, UNKNOWN_VERSION } from '@activepieces/server-utils'
import { HOSTED_ACCOUNTING_PROTOCOL, HOSTED_RUNTIME_CAPABILITIES, HOSTED_RUNTIME_PROFILE, serviceModePolicy, WorkerProps, WorkerSettingsResponse } from '@activepieces/shared'
import { system, WorkerSystemProp } from './configs'
import { getWorkerLaneConfiguration } from './worker-lanes'

function getProps(): WorkerProps {
    return {
        serviceMode: serviceModePolicy.resolve({ value: system.get(WorkerSystemProp.SERVICE_MODE) }),
        accountingProtocol: HOSTED_ACCOUNTING_PROTOCOL, runtimeProfile: HOSTED_RUNTIME_PROFILE,
        capabilities: [...HOSTED_RUNTIME_CAPABILITIES], version: apVersionUtil.getCurrentRelease(),
        EXECUTION_MODE: system.get(WorkerSystemProp.EXECUTION_MODE) ?? 'SANDBOX_CODE_ONLY',
    }
}

function assertSettings({ response }: { response: WorkerSettingsResponse }): void {
    const localMode = serviceModePolicy.resolve({ value: system.get(WorkerSystemProp.SERVICE_MODE) })
    serviceModePolicy.assertWorkerSettings({ localMode, serverMode: response.SERVICE_MODE, accountingProtocol: response.HOSTING_ACCOUNTING_PROTOCOL, runtimeProfile: response.HOSTING_RUNTIME_PROFILE, capabilities: response.HOSTING_RUNTIME_CAPABILITIES })
    if (localMode === 'hosted') {
        const release = apVersionUtil.getCurrentRelease()
        if (release === UNKNOWN_VERSION || response.APP_VERSION !== release || response.EXECUTION_MODE !== 'SANDBOX_CODE_ONLY') throw new Error('Hosted API release or isolation mode does not match worker')
    }
    assertRuntimeAvailable()
}

function assertRuntimeAvailable(): void {
    if (serviceModePolicy.resolve({ value: system.get(WorkerSystemProp.SERVICE_MODE) }) !== 'hosted') return
    const mode = system.get(WorkerSystemProp.EXECUTION_MODE)
    if (mode && mode !== 'SANDBOX_CODE_ONLY') throw new Error('Hosted workers require SANDBOX_CODE_ONLY')
    if (system.get(WorkerSystemProp.WORKER_GROUP_ID) || system.getBoolean(WorkerSystemProp.PROJECT_WORKER)) throw new Error('Hosted pilot requires shared workers')
    getWorkerLaneConfiguration()
}

export const workerServiceMode = { getProps, assertSettings, assertRuntimeAvailable }
