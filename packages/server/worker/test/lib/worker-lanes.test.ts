import { WorkerProps } from '@activepieces/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkerLaneConfiguration } from '../../src/lib/config/worker-lanes'

afterEach(() => vi.unstubAllEnvs())
function hosted(): void {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    for (const name of ['AP_WORKER_CONCURRENCY', 'AP_WORKER_TOOLS_CONCURRENCY', 'AP_WORKER_REFRESH_CONCURRENCY']) vi.stubEnv(name, '20')
}
describe('independent hosted execution lanes', () => {
    it('assigns 20 distinct boxes to each lane without lending dependent slots to parents', () => {
        hosted()
        const config = getWorkerLaneConfiguration()
        expect(config).toMatchObject({ ordinary: 20, tools: 20, refresh: 20 })
        expect(config.lanes).toHaveLength(60)
        expect(config.lanes.slice(0, 20)).toEqual(Array(20).fill(undefined))
        expect(config.lanes.slice(20, 40)).toEqual(Array(20).fill('tools'))
        expect(config.lanes.slice(40, 60)).toEqual(Array(20).fill('refresh'))
        expect(WorkerProps.parse({ WORKER_CONCURRENCY: '20', WORKER_TOOLS_CONCURRENCY: '20', WORKER_REFRESH_CONCURRENCY: '20' })).toEqual({ WORKER_CONCURRENCY: '20', WORKER_TOOLS_CONCURRENCY: '20', WORKER_REFRESH_CONCURRENCY: '20' })
    })
    it('allows independent values and preserves the existing hosted defaults', () => {
        hosted()
        vi.stubEnv('AP_WORKER_TOOLS_CONCURRENCY', '3')
        vi.stubEnv('AP_WORKER_REFRESH_CONCURRENCY', '2')
        expect(getWorkerLaneConfiguration().lanes).toHaveLength(25)
        for (const name of ['AP_WORKER_CONCURRENCY', 'AP_WORKER_TOOLS_CONCURRENCY', 'AP_WORKER_REFRESH_CONCURRENCY']) vi.stubEnv(name, undefined)
        expect(getWorkerLaneConfiguration()).toMatchObject({ ordinary: 5, tools: 1, refresh: 1 })
    })
    it.each(['AP_WORKER_CONCURRENCY', 'AP_WORKER_TOOLS_CONCURRENCY', 'AP_WORKER_REFRESH_CONCURRENCY'])('rejects missing, fractional, zero or excessive bounds for %s', name => {
        hosted()
        for (const value of ['', '0', '-1', '1.5', '21', '1000', '2e1', '20 ', '020', 'invalid']) {
            vi.stubEnv(name, value)
            expect(() => getWorkerLaneConfiguration()).toThrow('between 1 and 20')
        }
    })
    it('keeps self-hosted execution free of hosted lanes and new bounds', () => {
        hosted()
        vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
        vi.stubEnv('AP_WORKER_CONCURRENCY', '25')
        vi.stubEnv('AP_WORKER_TOOLS_CONCURRENCY', 'invalid')
        const config = getWorkerLaneConfiguration()
        expect(config).toMatchObject({ ordinary: 25, tools: 0, refresh: 0 })
        expect(config.lanes).toEqual(Array(25).fill(undefined))
    })
})
