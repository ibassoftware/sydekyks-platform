import { serviceModePolicy } from '@activepieces/shared'
import { system, WorkerSystemProp } from './configs'

export type HostedWorkerLane = 'tools' | 'refresh'
export type WorkerLaneConfiguration = {
    ordinary: number
    tools: number
    refresh: number
    lanes: (HostedWorkerLane | undefined)[]
}

export function getWorkerLaneConfiguration(): WorkerLaneConfiguration {
    const hosted = serviceModePolicy.resolve({ value: system.get(WorkerSystemProp.SERVICE_MODE) }) === 'hosted'
    const rawOrdinary = system.get(WorkerSystemProp.WORKER_CONCURRENCY)
    const parsedOrdinary = Number(rawOrdinary)
    const ordinary = hosted ? hostedConcurrency(WorkerSystemProp.WORKER_CONCURRENCY) : Number.isInteger(parsedOrdinary) && parsedOrdinary > 0 ? parsedOrdinary : 1
    // Free installations retain their existing ordinary concurrency and do not
    // acquire hosted dependent lanes, regardless of these optional variables.
    const tools = hosted ? hostedConcurrency(WorkerSystemProp.WORKER_TOOLS_CONCURRENCY) : 0
    const refresh = hosted ? hostedConcurrency(WorkerSystemProp.WORKER_REFRESH_CONCURRENCY) : 0
    return {
        ordinary, tools, refresh,
        lanes: [...Array<undefined>(ordinary).fill(undefined), ...Array<HostedWorkerLane>(tools).fill('tools'), ...Array<HostedWorkerLane>(refresh).fill('refresh')],
    }
}

function hostedConcurrency(prop: WorkerSystemProp): number {
    const value = system.get(prop)
    if (!value || !/^([1-9]|1[0-9]|20)$/.test(value)) {
        throw new Error(`Hosted worker concurrency ${prop} must be an integer between 1 and 20`)
    }
    return Number(value)
}
