import { ActivepiecesError, AIProviderName, ErrorCode, tryCatchSync } from '@activepieces/core-utils'
import { ModelTier, modelTierCatalog, ModelTierSurface } from '@activepieces/server-utils'
import { ACTIVEPIECES_CHAT_TIERS, AgentRunSource, AiProviderCredentials, AiProviderModelScope, AIProviderModelType, aiProviderUtils } from '@activepieces/shared'

function surfaceOf({ source }: { source?: AgentRunSource }): ModelTierSurface {
    if (source !== undefined && source !== AgentRunSource.CHAT) throw new Error('Syd copilot only supports CHAT')
    return 'chat'
}

function findTier({ tierId, surface }: TierParams): ModelTier | undefined {
    return tierId === null ? undefined : modelTierCatalog.current(surface).findTier({ tierId })
}

function resolveTier({ tierId, surface }: TierParams): ModelTier {
    return modelTierCatalog.current(surface).resolveTier({ tierId })
}

function resolveRunTier({ selectedModel, surface }: { selectedModel: string | null, surface: ModelTierSurface, provider: AIProviderName, modelName: string | null }): ModelTier {
    return resolveTier({ tierId: selectedModel, surface })
}

function nativeModelIdFor({ tier }: { tier: ModelTier }): string | null {
    return tier.nativeModelId ?? ACTIVEPIECES_CHAT_TIERS.find((entry) => entry.id === tier.id)?.nativeModelId ?? null
}

function manualTextModelCatalog({ config }: { config?: AiProviderCredentials['config'] }): string[] | undefined {
    if (!config || !('models' in config) || config.models == null) return undefined
    return config.models.flatMap((entry) => entry.modelType === AIProviderModelType.TEXT ? [entry.modelId] : [])
}

function pickAllowedModel({ provider, selectedModel, candidates, modelScope, modelIds }: CandidateParams): string {
    const permitted = candidates.filter((model) => modelScope !== 'selected' || modelIds?.includes(model))
    if (!permitted.length) throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: provider, entityType: 'AIProvider', message: 'This key has no available text model' } })
    return permitted.find((model) => model === selectedModel) ?? permitted[0]
}

function resolveModelIdForProvider({ provider, selectedModel, surface, config, modelScope, modelIds }: SelectionParams): string {
    const custom = manualTextModelCatalog({ config })
    if (custom !== undefined) return pickAllowedModel({ provider, selectedModel, candidates: custom, modelScope, modelIds })
    if (surface === 'flow' && selectedModel && !findTier({ tierId: selectedModel, surface }) && provider !== AIProviderName.ACTIVEPIECES) {
        if (modelScope === 'selected' && !modelIds?.includes(selectedModel)) throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityType: 'AIProvider', entityId: provider } }, 'The configured model is unavailable on this key')
        return selectedModel
    }
    const tier = resolveTier({ tierId: selectedModel, surface })
    if (provider === AIProviderName.ACTIVEPIECES || provider === AIProviderName.OPENROUTER) return pickAllowedModel({ provider, selectedModel: tier.modelId, candidates: modelTierCatalog.current(surface).tiers.map((entry) => entry.modelId), modelScope, modelIds })
    const preferred = selectedModel ?? nativeModelIdFor({ tier })
    const candidates = aiProviderUtils.runnableChatModelIds({ provider })
    return pickAllowedModel({ provider, selectedModel: candidates.includes(preferred ?? '') ? preferred : nativeModelIdFor({ tier }), candidates, modelScope, modelIds })
}

function conversationModelName({ provider, modelId, surface }: { provider: AIProviderName, modelId: string, surface: ModelTierSurface }): string {
    return provider === AIProviderName.ACTIVEPIECES || provider === AIProviderName.OPENROUTER ? modelTierCatalog.current(surface).tiers.find((tier) => tier.modelId === modelId)?.id ?? modelId : modelId
}

function defaultModelIdForProvider({ provider, surface }: { provider: AIProviderName, surface: ModelTierSurface }): string | null {
    return tryCatchSync(() => resolveModelIdForProvider({ provider, selectedModel: modelTierCatalog.current(surface).defaultTierId, surface })).data
}

function resolveModelIdForAnalytics({ provider, selectedModel, surface }: { provider: AIProviderName | null, selectedModel: string | null, surface: ModelTierSurface }): string | null {
    if (selectedModel === null) return null
    if (provider !== null) return resolveModelIdForProvider({ provider, selectedModel, surface })
    return findTier({ tierId: selectedModel, surface })?.modelId ?? (aiProviderUtils.isCuratedChatModelId({ modelId: selectedModel }) ? selectedModel : null)
}

export const sydChatModelSelection = { surfaceOf, findTier, resolveTier, resolveRunTier, nativeModelIdFor, manualTextModelCatalog, pickAllowedModel, resolveModelIdForProvider, conversationModelName, defaultModelIdForProvider, resolveModelIdForAnalytics }

type TierParams = { tierId: string | null, surface: ModelTierSurface }
type CandidateParams = { provider: AIProviderName, selectedModel: string | null, candidates: string[], modelScope?: AiProviderModelScope, modelIds?: string[] }
type SelectionParams = Omit<CandidateParams, 'candidates'> & { surface: ModelTierSurface, config?: AiProviderCredentials['config'] }
