import { ActivepiecesError, AIProviderName, apId, ErrorCode, sanitizeObjectForPostgresql, tryCatch, tryCatchSync } from '@activepieces/core-utils'
import { aiUtils, modelTierCatalog, ModelTierSurface } from '@activepieces/server-utils'
import { AgentConversationStatus, AgentRunSource, AI_PROVIDER_CAPABILITIES, AI_PROVIDER_ENTITY_TYPES, AIProviderModelType, ApEdition, GetAgentMemoryResponse, GetProviderConfigResponse, Project, ProjectType, UserMemory } from '@activepieces/shared'
import { LanguageModel } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { Repository } from 'typeorm'
import { aiProviderService, ProviderScope } from '../../ai/ai-provider-service'
import { transaction } from '../../core/db/transaction'
import { databaseConnection } from '../../database/database-connection'
import { redisConnections } from '../../database/redis-connections'
import { system } from '../../helper/system/system'
import { platformService } from '../../platform/platform.service'
import { projectService } from '../../project/project-service'
import { userService } from '../../user/user-service'
import { sydChatModelSelection } from './chat-model-selection'
import { ConversationIdentifier, sydConversationService } from './conversation-service'
import { SydConversationEntity } from './models/conversation.entity'
import { SydUserMemoryEntity, SydUserMemoryWithRelations } from './models/user-memory.entity'

function isEvalConversationId(id: string): boolean {
    return id.startsWith('evalconv')
}
function conversationRepo() {
    return databaseConnection().getRepository(SydConversationEntity)
}

async function getConversationOrThrow({ log, ...scope }: ConversationIdentifier & { log: FastifyBaseLogger }) {
    return sydConversationService(log).getConversationOrThrow(scope)
}

async function getUserProjects({ platformId, userId, log }: ActorScope & { log: FastifyBaseLogger }): Promise<Project[]> {
    const users = userService(log)
    const user = await users.getOneOrFail({ id: userId })
    if (user.platformId !== platformId) throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: userId, entityType: 'User' } })
    const projects = await projectService(log).getAllForUser({ platformId, userId, isPrivileged: users.isUserPrivileged(user) })
    return projects.filter((project) => project.type !== ProjectType.PERSONAL || project.ownerId === userId)
}

function runScopeOrThrow({ projectId }: { projectId: string | null }): ProviderScope {
    if (!projectId) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'No accessible project is available for this chat' } })
    return { type: 'project', projectId }
}

function selectRunProject({ conversationProjectId, projects }: { conversationProjectId: string | null, projects: Project[] }): string | null {
    return projects.find((project) => project.id === conversationProjectId)?.id ?? projects[0]?.id ?? null
}

async function assertProjectSwitchKeepsKey({ platformId, provider, providerConfigId, fromProjectId, toProjectId, log }: ProjectSwitchParams): Promise<void> {
    if (!fromProjectId || fromProjectId === toProjectId) return
    const permitted = await aiProviderService(log).keyServesScope({ platformId, provider, configId: providerConfigId,
        resolvedFor: { type: 'project', projectId: fromProjectId }, target: toProjectId ? { type: 'project', projectId: toProjectId } : { type: 'platform' } })
    if (!permitted) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'The current AI key is unavailable in that project' } })
}

async function resolveChatProvider({ platformId, scope, log }: ProviderParams): Promise<GetProviderConfigResponse> {
    const resolved = await aiProviderService(log).getChatProvider({ platformId, scope })
    if (!resolved) throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: platformId, entityType: AI_PROVIDER_ENTITY_TYPES.chatProvider } })
    return resolved
}

async function resolveRunProvider({ platformId, provider, providerConfigId, scope, log }: ProviderParams): Promise<GetProviderConfigResponse> {
    return provider ? aiProviderService(log).getConfigOrThrow({ platformId, provider, configId: providerConfigId, scope }) : resolveChatProvider({ platformId, scope, log })
}

async function assertRunProviderConfigured({ platformId, provider, providerConfigId, scope, log }: Omit<ProviderParams, 'provider' | 'providerConfigId'> & { provider?: AIProviderName | null, providerConfigId?: string | null }): Promise<void> {
    const service = aiProviderService(log)
    const configured = provider ? await service.exists({ platformId, provider, scope, configId: providerConfigId ?? undefined }) : await service.getChatProviderName({ platformId, scope }) !== null
    if (!configured) throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: provider ?? platformId, entityType: AI_PROVIDER_ENTITY_TYPES.chatProvider } })
}

async function resolveModelId({ platformId, providerConfig, selectedModel, surface, scope, fallbackModelId, log }: ModelParams & { selectedModel: string | null }): Promise<string> {
    const attempted = tryCatchSync(() => sydChatModelSelection.resolveModelIdForProvider({ ...providerConfig, selectedModel, surface }))
    if (attempted.data !== null) return attempted.data
    if (!(attempted.error instanceof ActivepiecesError) || attempted.error.error.code !== ErrorCode.ENTITY_NOT_FOUND) throw attempted.error
    if (fallbackModelId && (providerConfig.modelScope !== 'selected' || providerConfig.modelIds.includes(fallbackModelId))) return fallbackModelId
    const models = await aiProviderService(log).listModels({ platformId, provider: providerConfig.provider, configId: providerConfig.configId, scope })
    const text = models.filter((model) => model.type === AIProviderModelType.TEXT)
    if (!text.length) throw attempted.error
    const nativeId = sydChatModelSelection.nativeModelIdFor({ tier: sydChatModelSelection.resolveTier({ tierId: selectedModel, surface }) })
    return text.find((model) => model.id === selectedModel)?.id ?? (nativeId ? text.find((model) => model.id.includes(nativeId))?.id : undefined) ?? text[0].id
}

async function resolveFastModelId(params: ModelParams): Promise<string> {
    return resolveModelId({ ...params, selectedModel: modelTierCatalog.current(params.surface).fastTierId })
}

async function resolveFastModel({ platformId, provider, providerConfigId, surface, scope, fallbackModelId, log }: ProviderParams & { surface: ModelTierSurface, fallbackModelId?: string }): Promise<LanguageModel> {
    const credentials = await resolveRunProvider({ platformId, provider, providerConfigId, scope, log })
    const modelId = await resolveFastModelId({ platformId, providerConfig: credentials, scope, surface, fallbackModelId, log })
    return aiUtils.createModel({ platformId, providerConfigId: credentials.configId, credentials, modelId })
}

async function resolveImageModelId({ platformId, providerConfig, scope, log }: Omit<ModelParams, 'surface'>): Promise<string | undefined> {
    const preferred = AI_PROVIDER_CAPABILITIES[providerConfig.provider].defaultImageModel
    if (!preferred || providerConfig.provider === AIProviderName.ACTIVEPIECES) return preferred
    const outcome = await Promise.race([
        tryCatch(() => aiProviderService(log).listModels({ platformId, provider: providerConfig.provider, configId: providerConfig.configId, scope })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ])
    if (!outcome?.data) return undefined
    const images = outcome.data.filter((model) => model.type === AIProviderModelType.IMAGE).map((model) => model.id)
    const family = preferred.split(/\d/)[0]
    return images.includes(preferred) ? preferred : images.find((model) => model.startsWith(family))
}

async function resolveChatProviderName({ platformId, projectId, log }: { platformId: string, projectId: string | null, log: FastifyBaseLogger }): Promise<AIProviderName | null> {
    return projectId ? aiProviderService(log).getChatProviderName({ platformId, scope: runScopeOrThrow({ projectId }) }) : null
}

async function agentsSurfaceAvailable({ platformId, log }: { platformId: string, log: FastifyBaseLogger }): Promise<boolean> {
    return system.getEdition() === ApEdition.COMMUNITY || (await platformService(log).getOneWithPlanOrThrow(platformId)).plan.agentsEnabled
}

async function recoverAllStaleStreamingConversations({ platformId, log }: { platformId?: string, log: FastifyBaseLogger }): Promise<{ recovered: number }> {
    const platformIds = platformId ? [platformId] : (await platformService(log).getAll()).map((platform) => platform.id)
    if (!platformIds.length) return { recovered: 0 }
    const result = await conversationRepo().createQueryBuilder().update().set({ status: AgentConversationStatus.IDLE })
        .where({ source: AgentRunSource.CHAT, status: AgentConversationStatus.STREAMING }).andWhere('"platformId" IN (:...platformIds)', { platformIds })
        .andWhere('updated < :threshold', { threshold: new Date(Date.now() - 90_000) }).returning('id').execute()
    const recovered = Array.isArray(result.raw) ? result.raw.length : 0
    if (recovered) log.warn({ platform: { id: platformId }, recovered }, 'Recovered stale Syd conversations')
    return { recovered }
}

async function incrementAndCheckLimit({ key, limit, ttlSeconds }: { key: string, limit: number, ttlSeconds: number }): Promise<{ allowed: boolean, count: number }> {
    const client = await redisConnections.useExisting()
    const raw = await client.eval('local n = redis.call(\'INCR\', KEYS[1]); if n == 1 then redis.call(\'EXPIRE\', KEYS[1], ARGV[1]) end; return n', 1, key, ttlSeconds)
    if (typeof raw !== 'number') throw new Error('Rate limit counter did not return a number')
    return { allowed: raw <= limit, count: raw }
}

async function getUserMemory({ platformId, userId }: ActorScope): Promise<GetAgentMemoryResponse> {
    const row = await databaseConnection().getRepository(SydUserMemoryEntity).findOneBy({ platformId, userId })
    return { instructions: row?.instructions ?? null, memories: row?.memories ?? [] }
}

function capMemories({ instructions, memories }: { instructions: string | null, memories: string[] }): GetAgentMemoryResponse {
    const facts = memories.flatMap((fact) => {
        const text = fact.trim().slice(0, 280); return text ? [text] : []
    })
    return { instructions: instructions?.trim().slice(0, 4000) || null, memories: [...new Set(facts)].slice(0, 50) }
}

async function withLockedMemoryRow<T>({ platformId, userId, operation }: ActorScope & { operation: (args: { repo: Repository<SydUserMemoryWithRelations>, row: UserMemory }) => Promise<T> }): Promise<T> {
    return transaction(async (manager) => {
        const repo = manager.getRepository(SydUserMemoryEntity)
        await repo.createQueryBuilder().insert().values({ id: apId(), platformId, userId, instructions: null, memories: [] }).orIgnore().execute()
        const row = await repo.findOne({ where: { platformId, userId }, lock: { mode: 'pessimistic_write' } })
        if (!row) throw new Error('Memory row was not created')
        return operation({ repo, row })
    })
}

function mergeMemories({ base, incoming, current }: { base: string[], incoming: string[], current: string[] }): string[] {
    const prior = new Set(base)
    const live = new Set(current)
    return [...new Set(incoming.filter((fact) => !prior.has(fact) || live.has(fact)).concat(current.filter((fact) => !prior.has(fact))))]
}

async function saveUserMemory({ platformId, userId, instructions, memories, baseMemories }: SaveMemoryParams): Promise<GetAgentMemoryResponse> {
    return withLockedMemoryRow({ platformId, userId, operation: async ({ repo, row }) => {
        const next = memories === undefined ? row.memories : baseMemories === undefined ? memories : mergeMemories({ base: baseMemories, incoming: memories, current: row.memories })
        const view = sanitizeObjectForPostgresql(capMemories({ instructions: instructions === undefined ? row.instructions ?? null : instructions, memories: next }))
        await repo.update({ platformId, userId }, view)
        return view
    } })
}

async function claimConversationForRun({ conversationId, platformId, userId, runId }: RunIdentifier): Promise<{ preemptedRunId: string | null, wasStreaming: boolean }> {
    return transaction(async (manager) => {
        const repo = manager.getRepository(SydConversationEntity)
        const scope = { id: conversationId, platformId, userId, source: AgentRunSource.CHAT }
        const row = await repo.findOneOrFail({ where: scope, lock: { mode: 'pessimistic_write' } })
        await repo.update(scope, { activeRunId: runId, status: AgentConversationStatus.IDLE })
        const wasStreaming = row.status === AgentConversationStatus.STREAMING
        return { preemptedRunId: row.activeRunId ?? null, wasStreaming }
    })
}

async function acquireStreamingLock({ conversationId, platformId, userId, runId }: ActorScope & { conversationId: string, runId?: string }): Promise<StreamingLockResult> {
    const scope = { id: conversationId, platformId, userId, source: AgentRunSource.CHAT }
    const query = conversationRepo().createQueryBuilder().update().set({ status: AgentConversationStatus.STREAMING })
        .where(scope).andWhere('status != :streaming', { streaming: AgentConversationStatus.STREAMING })
    if (runId !== undefined) query.andWhere('("activeRunId" IS NULL OR "activeRunId" = :runId)', { runId })
    const result = await query.returning('id').execute()
    if (Array.isArray(result.raw) && result.raw.length) return 'acquired'
    const row = await conversationRepo().findOneBy(scope)
    return runId !== undefined && row?.activeRunId !== null && row?.activeRunId !== runId ? 'superseded' : 'busy'
}

export const sydCopilotContext = {
    isEvalConversationId, conversationRepo, getConversationOrThrow, getUserProjects, runScopeOrThrow, selectRunProject,
    recoverAllStaleStreamingConversations, incrementAndCheckLimit,
    getUserMemory, capMemories, withLockedMemoryRow, mergeMemories, saveUserMemory, claimConversationForRun, acquireStreamingLock,
    assertProjectSwitchKeepsKey, resolveChatProvider, resolveRunProvider, assertRunProviderConfigured, resolveModelId,
    resolveFastModelId, resolveFastModel, resolveImageModelId, resolveChatProviderName, agentsSurfaceAvailable,
}

export type ActorScope = { platformId: string, userId: string }
export type RunIdentifier = ActorScope & { conversationId: string, runId: string }
export type StreamingLockResult = 'acquired' | 'busy' | 'superseded'
type SaveMemoryParams = ActorScope & { instructions?: string | null, memories?: string[], baseMemories?: string[] }
type ProviderParams = { platformId: string, provider?: AIProviderName, providerConfigId?: string, scope: ProviderScope, log: FastifyBaseLogger }
type ProjectSwitchParams = Omit<ProviderParams, 'scope'> & { fromProjectId: string | null, toProjectId: string | null }
type ModelParams = Omit<ProviderParams, 'provider' | 'providerConfigId'> & { providerConfig: GetProviderConfigResponse, surface: ModelTierSurface, fallbackModelId?: string }
