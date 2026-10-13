import { ActivepiecesError, ErrorCode, sanitizeObjectForPostgresql } from '@activepieces/core-utils'
import { AgentConversationStatus, AgentCreditsLeftRequest, AgentRunSource, FileCompression, FileType, HeartbeatAgentConversationRequest, PersistedAgentMessage, PersistedAgentPartType, PersistedAgentRole, ReadAgentFileRequest, ReadFlowStepFileResponse, SaveAgentFileRequest, SaveAgentFileResponse, SaveAgentMessagesRequest, UpdateAgentProgressRequest, UpdateProjectContextRequest } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { transaction } from '../../../core/db/transaction'
import { fileService } from '../../../file/file.service'
import { filesService } from '../../../file/files-service'
import { rejectedPromiseHandler } from '../../../helper/promise-handler'
import { creditsLeftAfter } from '../../../platform/billing-provider'
import { sydAgentRuntime } from '../agent-runtime'
import { sydConversationFiles } from '../conversation-files'
import { sydCopilotContext } from '../copilot-context'
import { SydConversationEntity } from '../models/conversation.entity'
import { sydToolUsage } from '../tool-usage'
import { sydRunOperations } from './run-operations'

export const sydConversationRpc = (log: FastifyBaseLogger) => ({
    async saveAgentFile(input: SaveAgentFileRequest): Promise<SaveAgentFileResponse> {
        const conversation = await sydRunOperations.conversationForRpc({ conversationId: input.conversationId, platformId: input.platformId })
        const file = await fileService(log).save({ platformId: input.platformId, projectId: conversation.projectId ?? input.projectId, data: input.data, size: input.data.length, type: FileType.FLOW_STEP_FILE, compression: FileCompression.NONE, fileName: input.fileName, metadata: { conversationId: conversation.id, mimetype: input.mediaType } })
        return { fileId: file.id, url: await filesService.constructReadUrl({ platformId: input.platformId, fileId: file.id, fileType: file.type }) }
    },

    async readAgentFile(input: ReadAgentFileRequest): Promise<ReadFlowStepFileResponse> {
        const row = await sydRunOperations.conversationForRpc({ conversationId: input.conversationId, platformId: input.platformId })
        const projects = await sydCopilotContext.getUserProjects({ platformId: row.platformId, userId: row.userId, log })
        const file = await sydConversationFiles.readConversationFile({ platformId: row.platformId, conversationId: row.id, accessibleProjectIds: projects.map((project) => project.id), fileId: input.fileId, log })
        return { data: file.data, ...(file.fileName ? { fileName: file.fileName } : {}), ...(typeof file.metadata?.mimetype === 'string' ? { mimeType: file.metadata.mimetype } : {}) }
    },

    async saveAgentMessages(input: SaveAgentMessagesRequest): Promise<void> {
        const observed = await sydRunOperations.conversationForRpc({ conversationId: input.conversationId })
        const saved = await transaction(async (manager) => {
            const repo = observed.source === AgentRunSource.CHAT ? manager.getRepository(SydConversationEntity) : manager.getRepository(sydAgentRuntime.repo().target)
            const scope = { id: observed.id, platformId: observed.platformId, userId: observed.userId }
            const row = await repo.findOne({ where: scope, lock: { mode: 'pessimistic_write' } })
            if (!row || (input.runId && row.activeRunId && input.runId !== row.activeRunId)) return null
            const successful = input.messages.length > 0
            const noShrink = input.messages.length >= row.messages.length
            const updates: Record<string, unknown> = { status: successful ? AgentConversationStatus.IDLE : AgentConversationStatus.ERROR }
            if (successful && noShrink) {
                updates.messages = input.messages
                updates.uiMessages = sanitizeObjectForPostgresql(input.uiMessages)
                if (input.title) updates.title = input.title
                if (input.modelName) updates.modelName = input.modelName
            }
            if (input.failure) {
                const failure = failureAppendFor({ stored: row.uiMessages ?? [], failure: input.failure })
                updates.uiMessages = sanitizeObjectForPostgresql([...row.uiMessages ?? [], ...failure.uiMessages])
                updates.messages = sanitizeObjectForPostgresql([...row.messages, ...failure.modelMessages])
            }
            await repo.update(scope, sanitizeObjectForPostgresql(updates))
            return repo.findOneBy(scope)
        })
        if (saved && input.messages.length) rejectedPromiseHandler(sydToolUsage.chargeForLatestTurn({ conversation: saved, runId: input.runId, log }), log)
    },

    async updateAgentProgress(input: UpdateAgentProgressRequest): Promise<void> {
        await sydRunOperations.updateConversationForRun({ conversationId: input.conversationId, runId: input.runId, onlyWhileStreaming: true, updates: { uiMessages: sanitizeObjectForPostgresql(input.uiMessages), ...(input.messages ? { messages: input.messages } : {}) } })
    },

    async agentCreditsLeft(input: AgentCreditsLeftRequest): Promise<number | null> {
        return creditsLeftAfter({ platformId: input.platformId, pendingCredits: input.pendingCredits, log })
    },

    async heartbeatAgentConversation(input: HeartbeatAgentConversationRequest): Promise<void> {
        await sydRunOperations.updateConversationForRun({ conversationId: input.conversationId, runId: input.runId, onlyWhileStreaming: true, updates: { updated: () => 'now()' } })
    },

    async updateProjectContext(input: UpdateProjectContextRequest): Promise<void> {
        const row = await sydRunOperations.conversationForRpc({ conversationId: input.conversationId })
        if (row.source !== AgentRunSource.CHAT && input.projectId !== row.projectId) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'An agent run stays in its configured project' } })
        const projects = await sydCopilotContext.getUserProjects({ platformId: row.platformId, userId: row.userId, log })
        if (input.projectId !== null && !projects.some((project) => project.id === input.projectId)) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'The project is unavailable to this user' } })
        await sydCopilotContext.assertProjectSwitchKeepsKey({ platformId: row.platformId, fromProjectId: row.projectId ?? null, toProjectId: input.projectId, provider: input.provider, providerConfigId: input.providerConfigId, log })
        await sydRunOperations.updateConversationForRun({ conversationId: row.id, platformId: row.platformId, runId: input.runId, updates: { projectId: input.projectId } })
    },
})

function failureAppendFor({ stored, failure }: { stored: PersistedAgentMessage[], failure: { message: string, userMessage?: string } }): FailureAppend {
    const restoreUser = failure.userMessage !== undefined && stored.at(-1)?.role !== PersistedAgentRole.USER
    const user: PersistedAgentMessage[] = restoreUser ? [{ role: PersistedAgentRole.USER, parts: [{ type: PersistedAgentPartType.TEXT, text: failure.userMessage ?? '' }] }] : []
    return { uiMessages: [...user, { role: PersistedAgentRole.ASSISTANT, parts: [{ type: PersistedAgentPartType.TEXT, text: failure.message }] }], modelMessages: restoreUser ? [{ role: 'user', content: failure.userMessage ?? '' }] : [] }
}

type FailureAppend = { uiMessages: PersistedAgentMessage[], modelMessages: Record<string, unknown>[] }
