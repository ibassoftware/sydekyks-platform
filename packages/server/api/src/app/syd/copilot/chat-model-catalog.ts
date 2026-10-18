import { ActivepiecesError, AIProviderName, ErrorCode } from '@activepieces/core-utils'
import { modelTierCatalog } from '@activepieces/server-utils'
import { AIProviderModelType, aiProviderUtils } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { aiProviderService } from '../../ai/ai-provider-service'
import { HOSTED_MANAGED_MODEL } from '../../hosting/hosting-ai-policy'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { ActorScope, sydCopilotContext } from './copilot-context'

async function getModels({ platformId, userId, projectId, log }: ActorScope & { projectId: string, log: FastifyBaseLogger }): Promise<ChatModelCatalog> {
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    if (!projects.some((project) => project.id === projectId)) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'This command center is unavailable' } })
    if (hostingConfiguration.getServiceMode() === 'hosted') return { provider: AIProviderName.ACTIVEPIECES, models: [{ id: HOSTED_MANAGED_MODEL, label: 'Sydekyks' }], defaultModelId: HOSTED_MANAGED_MODEL }
    const scope = sydCopilotContext.runScopeOrThrow({ projectId })
    const credentials = await sydCopilotContext.resolveChatProvider({ platformId, scope, log })
    const allowed = (id: string) => credentials.modelScope !== 'selected' || credentials.modelIds.includes(id)
    const tiers = modelTierCatalog.current('chat')
    if (credentials.provider === AIProviderName.ACTIVEPIECES || credentials.provider === AIProviderName.OPENROUTER) {
        const models = tiers.tiers.filter((tier) => allowed(tier.modelId)).map((tier) => ({ id: tier.id, label: tier.label }))
        return { provider: credentials.provider, models, defaultModelId: models.find((model) => model.id === tiers.defaultTierId)?.id ?? models[0]?.id ?? null }
    }
    const curated = aiProviderUtils.getCuratedChatModels({ provider: credentials.provider })
    const candidates = curated ?? (await aiProviderService(log).listModels({ platformId, provider: credentials.provider, configId: credentials.configId, scope }))
        .filter((model) => model.type === AIProviderModelType.TEXT).map((model) => ({ id: model.id, label: model.name }))
    const models = candidates.filter((model) => allowed(model.id))
    return { provider: credentials.provider, models, defaultModelId: models[0]?.id ?? null }
}

export const sydChatModelCatalog = { getModels }

export type ChatModelCatalog = { provider: AIProviderName, models: { id: string, label: string }[], defaultModelId: string | null }
