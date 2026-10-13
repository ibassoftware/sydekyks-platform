import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { userIdentityHelper } from '../../helper/user-identity-helper'
import { platformService } from '../../platform/platform.service'
import { sydAgentController } from './agent-controller'
import { sydAgentConversationController } from './agent-conversation-controller'
import { sydCopilotAvailability } from './copilot-availability'

export const sydAgentModule: FastifyPluginAsyncZod = async (app) => {
    app.addHook('preHandler', async (request) => {
        const platform = await platformService(request.log).getOneWithPlanOrThrow(request.principal.platform.id)
        const isEmbedded = request.principal.type === PrincipalType.USER && await userIdentityHelper(request.log).isUserEmbedded(request.principal.id)
        if (!sydCopilotAvailability.resolveAgentsEnabledForUser({ platform, isEmbedded })) throw new ActivepiecesError({ code: ErrorCode.FEATURE_DISABLED, params: { message: 'Feature is disabled' } })
    })
    await app.register(sydAgentController, { prefix: '/v1/agents' })
    await app.register(sydAgentConversationController, { prefix: '/v1/agents' })
}
