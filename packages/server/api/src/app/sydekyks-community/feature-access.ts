import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { PlatformWithoutSensitiveData, PrincipalType } from '@activepieces/shared'
import { FastifyReply, FastifyRequest } from 'fastify'
import { platformService } from '../platform/platform.service'
import { userService } from '../user/user-service'

async function platformMustBeOwnedByCurrentUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (request.principal.type !== PrincipalType.USER) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'A platform owner account is required' } })
    const user = await userService(request.log).getOrThrow({ id: request.principal.id })
    const platform = await platformService(request.log).getOneOrThrow(request.principal.platform.id)
    if (user.platformId !== platform.id || user.id !== platform.ownerId) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'A platform owner account is required' } })
}

function platformMustHaveFeatureEnabled(check: (platform: PlatformWithoutSensitiveData) => boolean) {
    return async (request: FastifyRequest): Promise<void> => {
        if (!('platform' in request.principal)) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
        const platform = await platformService(request.log).getOneWithPlanOrThrow(request.principal.platform.id)
        if (!check(platform)) throw new ActivepiecesError({ code: ErrorCode.FEATURE_DISABLED, params: { message: 'This feature is not available in this release' } })
    }
}

export { platformMustBeOwnedByCurrentUser, platformMustHaveFeatureEnabled }
