import { AIProviderName } from '@activepieces/core-utils'
import { AgentRunSource, Permission } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager } from 'typeorm'
import { aiKeyScope } from '../ai/ai-key-scope'
import { AIProviderEntity } from '../ai/ai-provider-entity'
import { resolvePermissionChecker } from '../mcp/mcp-permissions'
import { SydAgentConversationEntity } from '../syd/copilot/models/agent-conversation.entity'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { sydChatAgentAdministration } from '../syd/copilot/tools/chat-agent-administration'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL } from './hosting-ai-policy'
import { HOSTED_MAX_ROOT_CREDITS } from './hosting-credit-policy'
import { readManagedConfiguration } from './hosting-managed-settings'
import { HOSTED_NATIVE_CREDIT_LIMIT } from './hosting-native-policy'
import { readApprovedNativeToolPricing, readApprovedPricing } from './hosting-pricing'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'
import { readHostedCredits } from './hosting-usage'

export async function hostedChatOptions({ manager, actor, userId, projectId: requestedProjectId, conversationId, agentId, builder = false, log }: { manager: EntityManager, actor: HostingActor, userId: string, projectId: string, conversationId?: string, agentId?: string, builder?: boolean, log?: FastifyBaseLogger }) {
    const rootConversation = conversationId ? await manager.getRepository(SydConversationEntity).findOneBy({ id: conversationId, platformId: actor.platformId, userId }) : null
    const agentConversation = conversationId && !rootConversation ? await manager.getRepository(SydAgentConversationEntity).findOneBy({ id: conversationId, platformId: actor.platformId, userId }) : null
    const conversation = rootConversation ?? agentConversation
    if (conversationId && !conversation) hostingFail('HOSTING_ACCESS_DENIED')
    if (agentConversation && ![AgentRunSource.AGENT, AgentRunSource.AGENT_BUILDER].includes(agentConversation.source)) hostingFail('HOSTING_ACCESS_DENIED')
    if (rootConversation && (agentId || builder)) hostingFail('HOSTING_ACCESS_DENIED')
    if (agentConversation && agentId && agentConversation.agentId !== agentId) hostingFail('HOSTING_ACCESS_DENIED')
    const projectId = conversation?.projectId ?? requestedProjectId
    await tx.member({ manager, actor, projectId, write: true })
    const selectedAgentId = agentConversation?.agentId ?? agentId
    const isBuilder = agentConversation ? agentConversation.source === AgentRunSource.AGENT_BUILDER : builder
    const native = !!agentConversation || !!agentId || builder
    let payerLock: { type: 'managed' } | { type: 'byok', configId: string } | undefined
    if (native) {
        if (!log) hostingFail('HOSTING_ACCESS_DENIED')
        const permission = await resolvePermissionChecker({ userId, projectId, log })
        if (permission.check(isBuilder ? Permission.WRITE_AGENT : Permission.READ_AGENT, 'agent-chat-options')) hostingFail('HOSTING_ACCESS_DENIED')
        const agent = selectedAgentId ? await sydChatAgentAdministration(log).getOneOrThrow({ id: selectedAgentId, projectId, userId }) : null
        if (!agent && !isBuilder) hostingFail('HOSTING_ACCESS_DENIED')
        const config = !isBuilder ? agent?.draft : undefined
        if (!config?.provider || config.provider === AIProviderName.ACTIVEPIECES) {
            if (config?.providerConfigId) hostingFail('HOSTING_AI_PAYER_CONFLICT')
            payerLock = { type: 'managed' }
        }
        else {
            if (config.provider !== AIProviderName.DEEPSEEK || !config.providerConfigId) hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
            payerLock = { type: 'byok', configId: config.providerConfigId }
        }
    }
    const rows = await manager.getRepository(AIProviderEntity).find({ where: { platformId: actor.platformId, provider: AIProviderName.DEEPSEEK, status: 'active' }, order: { displayName: 'ASC', id: 'ASC' } })
    let managedAvailable = false
    try {
        const managed = await readManagedConfiguration(manager, actor.platformId)
        if (!managed.disabled && managed.model && managed.secretId) {
            await readApprovedPricing(manager, await tx.now(manager), managed.model)
            managedAvailable = true
        }
    }
    catch {
        // Configuration availability only; never probe a provider or disclose its credentials.
    }
    const account = await tx.account({ manager, platformId: actor.platformId })
    const credits = await readHostedCredits(manager, account, await tx.now(manager))
    managedAvailable = managedAvailable && BigInt(credits.execution.available) > 0n
    const keys = rows.filter(row => !Object.keys(row.config).length && aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId } }) && aiKeyScope.keyOffersModel({ key: row, modelId: HOSTED_DEEPSEEK_MODEL })).map(row => ({ id: row.id, name: row.displayName }))
    const payerAvailable = payerLock?.type === 'managed' ? managedAvailable : payerLock?.type === 'byok' ? keys.some(key => key.id === payerLock.configId) : managedAvailable || keys.length > 0
    let webSearch = false
    try {
        // Tool charges require the same observed-and-approved tariff for both
        // payers. Missing native terms never disable ordinary chat.
        await readApprovedNativeToolPricing(manager, await tx.now(manager), HOSTED_DEEPSEEK_MODEL, 'search')
        await readApprovedNativeToolPricing(manager, await tx.now(manager), HOSTED_DEEPSEEK_MODEL, 'fetch')
        webSearch = payerAvailable
    }
    catch { /* Advertise only features that can currently be admitted. */ }
    return { ...(payerLock ? { payerLock } : {}), creditPolicy: { executionCredits: 1, maxRunCredits: HOSTED_MAX_ROOT_CREDITS.toString() }, credits: { execution: credits.execution }, platformId: actor.platformId, userId, requestedProjectId, projectId, conversationId: conversationId ?? null, model: { id: HOSTED_MANAGED_MODEL, label: 'Sydekyks' }, managedAvailable,
        nativeFeatures: { files: payerAvailable, webSearch, maxTurnCredits: Number(HOSTED_NATIVE_CREDIT_LIMIT), maxFilesPerTurn: 4 }, keys }
}
