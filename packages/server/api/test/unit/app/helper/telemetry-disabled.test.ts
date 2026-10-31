import { ApEdition } from '@activepieces/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLicenseKeyEvent, flushLicenseKeyPostHogEvents, shutdownTelemetry, telemetry } from '../../../../src/app/helper/telemetry.utils'
import { platformConfigurationService } from '../../../../src/app/platform/platform-configuration.service'
import { templateTelemetryService } from '../../../../src/app/template/template-telemetry/template-telemetry.service'

vi.mock('../../../../src/app/core/db/repo-factory', () => ({ repoFactory: () => () => {
    throw new Error('Telemetry must not write a configuration or read accounts while paused') 
} }))
const logSpy = { info: vi.fn(), error: vi.fn(), debug: vi.fn() }
const log = logSpy as never
afterEach(() => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks() 
})
describe('telemetry collection paused', () => {
    it.each([ApEdition.COMMUNITY, ApEdition.CLOUD, ApEdition.ENTERPRISE])('does not collect even when old configuration would enable it on %s', async edition => {
        vi.stubEnv('AP_EDITION', edition); vi.stubEnv('AP_TELEMETRY_ENABLED', 'true')
        const fetch = vi.fn();vi.stubGlobal('fetch', fetch)
        for (const handler of Object.values(telemetry(log))) await handler({} as never)
        captureLicenseKeyEvent({ licenseKey: 'synthetic-secret', event: 'platform_setup_report', properties: {} } as never)
        await flushLicenseKeyPostHogEvents();await shutdownTelemetry()
        templateTelemetryService(log).sendEvent({} as never)
        templateTelemetryService(log).sendEventForPlatform({} as never)
        expect(fetch).not.toHaveBeenCalled()
        expect(logSpy.info).not.toHaveBeenCalled()
    })
    it('reports telemetry disabled and selects no projects/platforms without touching saved data', async () => {
        const service = platformConfigurationService(log)
        expect(await service.isProductTelemetryEnabled({ platformId: 'p'.repeat(21) })).toBe(false)
        expect(await service.filterProjectsWithProductTelemetryEnabled({ projectIds: ['p'.repeat(21)] })).toEqual([])
        expect(await service.filterPlatformsWithInfraSetupTelemetryEnabled({ platformIds: ['p'.repeat(21)] })).toEqual([])
    })
    it.each(['isProductTelemetryEnabled', 'isInfraSetupTelemetryEnabled'])('refuses attempts to enable %s', async field => {
        await expect(platformConfigurationService(log).update({ platformId: 'p'.repeat(21), [field]: true })).rejects.toThrow(/VALIDATION|disabled/)
    })
})
