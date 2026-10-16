import { serviceModePolicy, WorkerProps, WorkerSettingsResponse } from '@activepieces/shared'
import { system, WorkerSystemProp } from './configs'

function getProps(): Pick<WorkerProps, 'serviceMode' | 'accountingProtocol'> {
    return { serviceMode: serviceModePolicy.resolve({ value: system.get(WorkerSystemProp.SERVICE_MODE) }), accountingProtocol: 0 }
}

function assertSettings({ response }: { response: Pick<WorkerSettingsResponse, 'SERVICE_MODE' | 'HOSTING_ACCOUNTING_PROTOCOL'> }): void {
    const localMode = serviceModePolicy.resolve({ value: system.get(WorkerSystemProp.SERVICE_MODE) })
    serviceModePolicy.assertWorkerSettings({ localMode, serverMode: response.SERVICE_MODE, accountingProtocol: response.HOSTING_ACCOUNTING_PROTOCOL })
    assertRuntimeAvailable()
}

function assertRuntimeAvailable(): void {
    if (serviceModePolicy.resolve({ value: system.get(WorkerSystemProp.SERVICE_MODE) }) === 'hosted') {
        throw new Error('HOSTED_IMPLEMENTATION_INCOMPLETE: hosted workers are disabled until admission and billing are implemented')
    }
}

export const workerServiceMode = { getProps, assertSettings, assertRuntimeAvailable }
