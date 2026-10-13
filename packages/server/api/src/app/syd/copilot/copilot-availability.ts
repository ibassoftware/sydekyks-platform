import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { ApEdition, chatVisibility, PrincipalType } from '@activepieces/shared'
import { onRequestAsyncHookHandler } from 'fastify'
import { system } from '../../helper/system/system'
import { userIdentityHelper } from '../../helper/user-identity-helper'
import { platformService } from '../../platform/platform.service'

function resolveChatEnabledForUser({ platform, isEmbedded }: { platform: { plan: { chatEnabled: boolean } }, isEmbedded: boolean }): boolean {
    if (system.getEdition() === ApEdition.COMMUNITY) return !isEmbedded
    return chatVisibility.resolveChatEnabled({ edition: system.getEdition(), isEmbedded, planChatEnabled: platform.plan.chatEnabled })
}

function resolveAgentsEnabledForUser({ platform, isEmbedded }: { platform: { plan: { agentsEnabled: boolean } }, isEmbedded: boolean }): boolean {
    return !isEmbedded && (system.getEdition() === ApEdition.COMMUNITY || platform.plan.agentsEnabled)
}

const chatVisibilityGuard: onRequestAsyncHookHandler = async (request) => {
    if (request.principal.type !== PrincipalType.USER || !('platform' in request.principal)) {
        throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'Platform user is required' } })
    }
    const [platform, embedded] = await Promise.all([
        platformService(request.log).getOneWithPlanOrThrow(request.principal.platform.id),
        userIdentityHelper(request.log).isUserEmbedded(request.principal.id),
    ])
    if (!resolveChatEnabledForUser({ platform, isEmbedded: embedded })) {
        throw new ActivepiecesError({ code: ErrorCode.FEATURE_DISABLED, params: { message: 'Feature is disabled' } })
    }
}

export const sydCopilotAvailability = { resolveChatEnabledForUser, resolveAgentsEnabledForUser, chatVisibilityGuard }
