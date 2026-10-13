import { ActivepiecesError, ErrorCode, tryCatch } from '@activepieces/core-utils'
import { agentAiUtils, aiUtils } from '@activepieces/server-utils'
import { AgentConfigResponse, AgentRunSource, GetAgentConfigRequest, GetEnabledAiToolsResponse, PersistedAgentMessage, PersistedAgentPartType, PersistedAgentRole } from '@activepieces/shared'
import { ModelMessage, modelMessageSchema } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { aiToolConfigService } from '../../../ai/ai-tool-config-service'
import { appConnectionService } from '../../../app-connection/app-connection-service/app-connection-service'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { platformService } from '../../../platform/platform.service'
import { userService } from '../../../user/user-service'
import { sydApprovalGate } from '../approval-gate'
import { sydChatModelSelection } from '../chat-model-selection'
import { sydConversationCompaction } from '../conversation-compaction'
import { sydConversationFiles } from '../conversation-files'
import { sydCopilotContext } from '../copilot-context'
import { sydEditorContext } from '../editor-context'
import { sydCopilotMcp } from '../mcp/copilot-mcp'
import { sydPersonalizationService } from '../personalization/personalization-service'
import { sydCopilotPrompt } from '../prompt/copilot-prompt'
import { sydRunContext } from '../prompt/run-context'
import { sydCapabilityProviders } from './capability-providers'
import { sydEmailRpc } from './email-rpc'
import { CONNECTION_INVENTORY_LIMIT, sydRunOperations } from './run-operations'

export const sydCopilotConfigRpc = (log: FastifyBaseLogger) => ({
    async getAgentConfig(input: GetAgentConfigRequest): Promise<AgentConfigResponse> {
        const { conversationId, platformId, userId, files, userMessage } = input
        const [conversation, projects, enabled, choices] = await Promise.all([
            sydRunOperations.loadOrStartConversation({ conversationId, platformId, userId, source: input.source, log }),
            sydCopilotContext.getUserProjects({ platformId, userId, log }),
            aiToolConfigService(log).getEnabledTools({ platformId }), aiToolConfigService(log).getProviderChoices({ platformId }),
        ])
        const selectedProjectId = sydCopilotContext.selectRunProject({ conversationProjectId: conversation.projectId ?? null, projects })
        const editor = input.editorContext ? await sydEditorContext.getForUser({ platformId, userId, context: input.editorContext, log }) : null
        if (editor && editor.projectId !== selectedProjectId) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'The editor and conversation belong to different command centers' } })
        const scope = sydCopilotContext.runScopeOrThrow({ projectId: selectedProjectId })
        const credentials = await sydCopilotContext.resolveRunProvider({ platformId, scope, provider: input.provider, providerConfigId: input.providerConfigId, log })
        const [mcp, memory, user, platform, personalization, agentsEnabled] = await Promise.all([
            sydCopilotMcp.getCredentials({ platformId, userId, log }), sydCopilotContext.getUserMemory({ platformId, userId }),
            userService(log).getMetaInformation({ id: userId }), tryCatch(() => platformService(log).getOneOrThrow(platformId)),
            tryCatch(() => sydPersonalizationService(log).getIdentityEnrichment({ platformId, userId })),
            sydCopilotContext.agentsSurfaceAvailable({ platformId, log }),
        ])
        const chosen = input.dryRun ? { search: null, image: null } : await sydCapabilityProviders.resolveForRun({ platformId, choices, scope, surface: 'chat', log })
        const active = !input.dryRun && !input.discoveryOnly
        const aiTools: GetEnabledAiToolsResponse = input.dryRun ? {} : enabled
        const searchAvailable = !input.dryRun && (Boolean(aiTools.webSearch) || aiUtils.supportsWebSearch((chosen.search?.credentials ?? credentials).provider))
        const imageModelId = active && !aiTools.imageGeneration ? chosen.image?.modelId ?? await sydCopilotContext.resolveImageModelId({ platformId, providerConfig: credentials, scope, log }) : undefined
        const emailEnabled = active && sydEmailRpc(log).isSmtpConfigured()
        const agentsAvailable = active && agentsEnabled
        const selectedModel = input.modelName ?? conversation.modelName ?? null
        const tier = sydChatModelSelection.resolveTier({ tierId: selectedModel, surface: 'chat' })
        const modelParams: Parameters<typeof sydCopilotContext.resolveFastModelId>[0] = { platformId, providerConfig: credentials, scope, surface: 'chat', log }
        const modelId = await sydCopilotContext.resolveModelId({ ...modelParams, selectedModel })
        const fastModelId = await sydCopilotContext.resolveFastModelId({ ...modelParams, fallbackModelId: modelId })
        const references = files?.length && selectedProjectId ? await sydConversationFiles.persistAgentAttachments({ files, projectId: selectedProjectId, platformId, conversationId, log }) : []
        const userContent = await sydConversationFiles.buildUserContentWithFiles({ text: userMessage, files, attachmentNote: sydConversationFiles.buildAttachmentNote(references) })
        const runId = input.runId ?? conversation.activeRunId ?? undefined
        const lock = await sydCopilotContext.acquireStreamingLock({ platformId, userId, conversationId, runId })
        if (lock !== 'acquired') throw new ActivepiecesError({ code: lock === 'superseded' ? ErrorCode.AGENT_RUN_SUPERSEDED : ErrorCode.VALIDATION, params: { message: lock === 'superseded' ? 'This message was replaced by a newer one' : 'An agent is already running for this conversation' } })
        const inventory = !input.dryRun && selectedProjectId ? await tryCatch(() => appConnectionService(log).list({ platformId, projectId: selectedProjectId, pieceName: undefined, displayName: undefined, status: undefined, cursorRequest: null, scope: undefined, externalIds: undefined, limit: CONNECTION_INVENTORY_LIMIT })) : null
        const systemPrompt = (editor ? `${editor.note}\n\n` : '') + sydCopilotPrompt.buildSystemPrompt({ projects, currentProjectId: selectedProjectId, frontendUrl: system.getOrThrow(AppSystemProp.FRONTEND_URL), templates: input.promptOverride }) + sydRunContext.buildRunNotes({
            source: AgentRunSource.CHAT, messageSource: input.messageSource, currentDate: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
            searchAvailable, fetchAvailable: !input.dryRun, scrapeAvailable: !input.dryRun && Boolean(aiTools.webScraping),
            imageAvailable: active && Boolean(aiTools.imageGeneration || imageModelId), imageEditAvailable: Boolean(imageModelId), emailAvailable: emailEnabled, agentsAvailable, userEmail: user.email,
            userIdentity: { firstName: user.firstName, lastName: user.lastName, email: user.email, platformName: platform?.data?.name ?? null, identity: personalization?.data ?? null },
            connections: inventory?.data ? { connections: inventory.data.data, truncated: inventory.data.data.length >= CONNECTION_INVENTORY_LIMIT } : null, memory,
        })
        const userTurn: ModelMessage = { role: 'user', content: userContent }
        const allMessages = [...conversation.messages.map((message) => modelMessageSchema.parse(message)), userTurn]
        const previousUiMessages: PersistedAgentMessage[] = [...conversation.uiMessages ?? [], { role: PersistedAgentRole.USER, parts: [{ type: PersistedAgentPartType.TEXT, text: userMessage }] }]
        const persisted = await sydRunOperations.updateConversationForRun({ conversationId, platformId, runId, updates: { messages: allMessages, uiMessages: previousUiMessages, ...(!input.dryRun ? { projectId: selectedProjectId } : {}) } })
        if (!persisted) throw new ActivepiecesError({ code: ErrorCode.AGENT_RUN_SUPERSEDED, params: { message: 'The active run changed during preparation' } })
        await sydApprovalGate.clearCancel({ conversationId })
        const history = agentAiUtils.collapseStaleToolOutputs({ messages: allMessages })
        const outputTokens = await agentAiUtils.affordableOutputTokens({ provider: credentials.provider, modelIds: [modelId, fastModelId], thinkingBudget: tier.thinkingBudget })
        const reservedTokens = outputTokens + 12_000
        const payloadReserve = reservedTokens + agentAiUtils.estimateTokenCount({ messages: [], systemPromptLength: systemPrompt.length })
        const estimate = sydConversationCompaction.estimateTokenCount({ messages: history, systemPromptLength: systemPrompt.length })
        let state = { summary: conversation.summary ?? null, summarizedUpToIndex: conversation.summarizedUpToIndex ?? null }
        if (sydConversationCompaction.shouldCompact({ estimatedTokens: estimate, provider: credentials.provider, reservedTokens, messageCount: history.length })) {
            state = await sydConversationCompaction.compactMessages({ messages: history, existingSummary: state.summary, summarizedUpToIndex: state.summarizedUpToIndex, provider: credentials.provider, reservedTokens: payloadReserve, model: aiUtils.createModel({ credentials, modelId }), log })
            await sydRunOperations.updateConversationForRun({ conversationId, platformId, runId, updates: state })
        }
        return { credentials, providerConfigId: credentials.configId, modelId, fastModelId, resolvedModelName: sydChatModelSelection.conversationModelName({ provider: credentials.provider, modelId, surface: 'chat' }),
            ...(imageModelId ? { imageModelId } : {}), ...(chosen.search ? { searchCredentials: chosen.search.credentials, searchModelId: chosen.search.modelId } : {}), ...(chosen.image ? { imageCredentials: chosen.image.credentials } : {}),
            systemPrompt, messages: sydConversationCompaction.buildCompactedPayload({ messages: history, ...state, provider: credentials.provider, reservedTokens: payloadReserve }), allMessages, previousUiMessages,
            tier: { id: tier.id, modelId: tier.modelId, thinkingBudget: tier.thinkingBudget }, mcpCredentials: mcp.mcpServerUrl && mcp.mcpToken ? { mcpServerUrl: mcp.mcpServerUrl, mcpToken: mcp.mcpToken } : null,
            projects: projects.map(({ id, displayName, type }) => ({ id, displayName, type })), guides: { ...sydCopilotPrompt.guides, ...input.promptOverride?.guides }, aiTools, emailEnabled, agentsAvailable, userEmail: user.email, source: AgentRunSource.CHAT,
        }
    },
})
