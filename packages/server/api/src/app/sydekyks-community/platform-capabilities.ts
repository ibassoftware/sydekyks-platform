import { OPEN_SOURCE_PLAN, PlatformPlanLimits } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { platformRepo } from '../platform/platform.service'

async function getCapabilities(platformId: string): Promise<PlatformPlanLimits> {
    await platformRepo().findOneByOrFail({ id: platformId })
    return { ...SYDEKYKS_CAPABILITIES }
}

export const platformPlanService = (_log: FastifyBaseLogger) => ({
    getOrCreateForPlatform: getCapabilities,
    onPlatformCreated: getCapabilities,
    async getUsage(_platformId: string): Promise<undefined> {
        return undefined 
    },
})

export const SYDEKYKS_CAPABILITIES: PlatformPlanLimits = {
    ...OPEN_SOURCE_PLAN,
    chatEnabled: true,
    agentsEnabled: true,
    analyticsEnabled: false,
    usersLimit: null,
    scheduledUsersLimit: null,
    projectsLimit: null,
    billedTeamProjectsLimit: null,
    activeFlowsLimit: null,
    licenseKey: null,
    licenseExpiresAt: null,
    plan: 'sydekyks',
}
