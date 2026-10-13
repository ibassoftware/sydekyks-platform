import { tryCatch } from '@activepieces/core-utils'
import { ModelTierSurface } from '@activepieces/server-utils'
import { AiProviderToolChoices, AiProviderToolConfig, AIProviderWithoutSensitiveData, GetProviderConfigResponse } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { aiProviderService, ProviderScope } from '../../../ai/ai-provider-service'
import { sydCopilotContext } from '../copilot-context'

async function keyCredentialsForRun({ platformId, configs, choice, scope, log }: ProviderChoiceParams): Promise<GetProviderConfigResponse | null> {
    const selected = choice ? configs.find((row) => row.id === choice.aiProviderId) : undefined
    if (!selected) return null
    const result = await tryCatch(() => aiProviderService(log).getConfigOrThrow({ platformId, provider: selected.provider, configId: selected.id, scope }))
    if (result.error) log.warn({ error: result.error, aiProvider: { id: selected.id } }, 'Syd capability provider cannot serve this run')
    return result.data ?? null
}

async function searchKeyWithFastModel({ platformId, credentials, surface, scope, log }: { platformId: string, credentials: GetProviderConfigResponse | null, surface: ModelTierSurface, scope: ProviderScope, log: FastifyBaseLogger }): Promise<ChosenProvider | null> {
    if (!credentials) return null
    const resolved = await tryCatch(() => sydCopilotContext.resolveFastModelId({ platformId, providerConfig: credentials, surface, scope, log }))
    return resolved.error ? null : { credentials, modelId: resolved.data }
}

function imageKeyIfModelAllowed({ credentials, modelId }: { credentials: GetProviderConfigResponse | null, modelId?: string, log: FastifyBaseLogger }): ChosenProvider | null {
    if (!credentials || !modelId || (credentials.modelScope === 'selected' && !credentials.modelIds.includes(modelId))) return null
    return { credentials, modelId }
}

async function resolveForRun({ platformId, choices, surface, scope, log }: { platformId: string, choices: AiProviderToolChoices, surface: ModelTierSurface, scope: ProviderScope, log: FastifyBaseLogger }): Promise<ChosenProviders> {
    if (!choices.webSearch && !choices.imageGeneration) return { search: null, image: null }
    const configs = await aiProviderService(log).listConfigs(platformId)
    const selected = await Promise.all([
        keyCredentialsForRun({ platformId, configs, choice: choices.webSearch, scope, log }),
        keyCredentialsForRun({ platformId, configs, choice: choices.imageGeneration, scope, log }),
    ])
    const search = await searchKeyWithFastModel({ platformId, credentials: selected[0], surface, scope, log })
    const image = imageKeyIfModelAllowed({ credentials: selected[1], modelId: choices.imageGeneration?.modelId, log })
    return { search, image }
}

export const sydCapabilityProviders = { resolveForRun, keyCredentialsForRun, searchKeyWithFastModel, imageKeyIfModelAllowed }

export type ChosenProvider = { credentials: GetProviderConfigResponse, modelId: string }
export type ChosenProviders = { search: ChosenProvider | null, image: ChosenProvider | null }
type ProviderChoiceParams = { platformId: string, configs: AIProviderWithoutSensitiveData[], choice?: AiProviderToolConfig, scope: ProviderScope, log: FastifyBaseLogger }
