import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { FastifyBaseLogger } from 'fastify'

export const workerGroupService = (_log: FastifyBaseLogger) => ({
    async isWorkerGroupsEnabled(_params: { platformId: string }): Promise<boolean> {
        return false 
    },
    async isCanaryPlatform(_params: { platformId: string }): Promise<boolean> {
        return false 
    },
    async getWorkerGroupId(_params: { platformId: string }): Promise<string | null> {
        return null 
    },
    async getWorkerGroupPlatformId(_params: { workerGroupId: string }): Promise<never> {
        throw new ActivepiecesError({ code: ErrorCode.FEATURE_DISABLED, params: { message: 'Dedicated worker groups are not supported' } }) 
    },
})

export const concurrencyPoolService = (_log: FastifyBaseLogger) => ({
    async getPoolLimit(_poolId: string): Promise<never> {
        throw new ActivepiecesError({ code: ErrorCode.FEATURE_DISABLED, params: { message: 'Concurrency pools are not supported' } }) 
    },
    async getProjectPoolId(_projectId: string): Promise<string | null> {
        return null 
    },
})
