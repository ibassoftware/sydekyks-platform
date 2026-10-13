import { ActivepiecesError, apId, ErrorCode, sanitizeObjectForPostgresql, SeekPage } from '@activepieces/core-utils'
import { AgentConversation, AgentConversationStatus, AgentHistoryMessage, AgentRunListItem, AgentRunSource, CreateAgentConversationRequest, PersistedAgentMessage, PersistedAgentRole, SetAgentMessageFeedbackRequest, UpdateAgentConversationRequest } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { transaction } from '../../core/db/transaction'
import { databaseConnection } from '../../database/database-connection'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { Order } from '../../helper/pagination/paginator'
import { projectService } from '../../project/project-service'
import { userService } from '../../user/user-service'
import { sydApprovalGate } from './approval-gate'
import { sydConversationHistory } from './history/conversation-history'
import { SydConversationEntity } from './models/conversation.entity'

export const sydConversationService = (log: FastifyBaseLogger) => ({
    async createConversation({ platformId, userId, request, id }: CreateConversationParams): Promise<AgentConversation> {
        if (request.agentId !== undefined || request.builder === true || id?.startsWith('evalconv')) {
            throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'Syd copilot requires a CHAT conversation' } })
        }
        if (request.projectId) {
            const user = await userService(log).getOneOrFail({ id: userId })
            const projects = await projectService(log).getAllForUser({ platformId, userId, isPrivileged: userService(log).isUserPrivileged(user) })
            if (!projects.some((project) => project.id === request.projectId && project.platformId === platformId)) notFound(request.projectId)
        }
        return transaction((manager) => manager.getRepository(SydConversationEntity).save({
            id: id ?? apId(), platformId, userId, projectId: request.projectId ?? null,
            source: AgentRunSource.CHAT, agentId: null, flowRunId: null,
            title: request.title ?? null, modelName: request.modelName ?? null,
            status: AgentConversationStatus.IDLE, activeRunId: null, aiCredits: null,
            messages: [], uiMessages: null, summary: null, summarizedUpToIndex: null,
        }))
    },

    async listConversations({ platformId, userId, cursor, limit }: ListConversationsParams): Promise<SeekPage<AgentRunListItem>> {
        const decoded = paginationHelper.decodeCursor(cursor)
        const paginator = buildPaginator({ entity: SydConversationEntity, query: {
            limit, orderBy: [{ field: 'created', order: Order.DESC }, { field: 'id', order: Order.DESC }],
            afterCursor: decoded.nextCursor, beforeCursor: decoded.previousCursor,
        } })
        const query = repository().createQueryBuilder('syd_conversation')
            .select(['id', 'created', 'updated', 'platformId', 'projectId', 'userId', 'title', 'modelName', 'status'].map((field) => `syd_conversation.${field}`))
            .where({ platformId, userId, source: AgentRunSource.CHAT })
            .andWhere('syd_conversation.id NOT LIKE :prefix', { prefix: 'evalconv%' })
        const page = await paginator.paginate(query)
        return paginationHelper.createPage(page.data, page.cursor)
    },

    async getConversationOrThrow({ id, platformId, userId }: ConversationIdentifier): Promise<AgentConversation> {
        const scope = { id, platformId, userId }
        if (scope.id.startsWith('evalconv')) notFound(scope.id)
        const row = await repository().findOneBy({ ...scope, source: AgentRunSource.CHAT })
        if (!row) notFound(scope.id)
        if (row.status !== AgentConversationStatus.STREAMING || Date.now() - Date.parse(row.updated) <= 90_000) return row
        const recovered = await repository().createQueryBuilder().update().set({ status: AgentConversationStatus.IDLE })
            .where({ ...scope, source: AgentRunSource.CHAT, status: AgentConversationStatus.STREAMING, updated: row.updated })
            .returning('id').execute()
        if (Array.isArray(recovered.raw) && recovered.raw.length) return { ...row, status: AgentConversationStatus.IDLE }
        const current = await repository().findOneBy({ ...scope, source: AgentRunSource.CHAT })
        if (!current) notFound(scope.id)
        return current
    },

    async updateConversation({ request, id, platformId, userId }: UpdateConversationParams): Promise<AgentConversation> {
        const scope = { id, platformId, userId }
        const row = await this.getConversationOrThrow(scope)
        const updates = {
            ...(request.title !== undefined ? { title: request.title } : {}),
            ...(request.modelName !== undefined ? { modelName: request.modelName } : {}),
        }
        if (Object.keys(updates).length) await repository().update(scope, updates)
        return { ...row, ...updates }
    },

    async deleteConversation({ id, platformId, userId }: ConversationIdentifier): Promise<void> {
        const scope = { id, platformId, userId }
        const row = await this.getConversationOrThrow(scope)
        if (row.status === AgentConversationStatus.STREAMING) {
            await sydApprovalGate.requestCancel({ conversationId: row.id, runId: row.activeRunId ?? undefined })
            await sydApprovalGate.requestCancel({ conversationId: row.id })
        }
        await sydApprovalGate.clearPendingGate({ conversationId: row.id })
        await repository().delete(scope)
    },

    async getMessages(scope: ConversationIdentifier): Promise<{ data: PersistedAgentMessage[] | AgentHistoryMessage[] }> {
        const row = await this.getConversationOrThrow(scope)
        return { data: row.uiMessages ?? sydConversationHistory.reconstruct(row.messages) }
    },

    async setMessageFeedback({ messageIndex, request, id, platformId, userId }: SetMessageFeedbackParams): Promise<void> {
        const scope = { id, platformId, userId }
        const row = await this.getConversationOrThrow(scope)
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || row.uiMessages?.[messageIndex]?.role !== PersistedAgentRole.ASSISTANT) notFound(`${scope.id}#${messageIndex}`)
        const path = [String(messageIndex), 'feedback']
        const feedback = sanitizeObjectForPostgresql({
            rating: request.rating,
            ...(request.reasons?.length ? { reasons: request.reasons } : {}),
            ...(request.comment?.trim() ? { comment: request.comment.trim() } : {}),
        })
        const patch = request.rating == null ? '"uiMessages" #- :path::text[]' : 'jsonb_set("uiMessages", :path::text[], :feedback::jsonb, true)'
        await repository().createQueryBuilder().update().set({ uiMessages: () => patch })
            .where(scope).andWhere('"uiMessages"->CAST(:messageIndex AS integer)->>\'role\' = :role', { messageIndex, role: PersistedAgentRole.ASSISTANT })
            .setParameters({ path, feedback: JSON.stringify(feedback) }).execute()
    },
})

function repository() {
    return databaseConnection().getRepository(SydConversationEntity)
}
function notFound(id: string): never {
    throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: id, entityType: 'AgentConversation' } })
}

export type ConversationIdentifier = { id: string, platformId: string, userId: string }
export type CreateConversationParams = { platformId: string, userId: string, request: CreateAgentConversationRequest, id?: string }
export type ListConversationsParams = { platformId: string, userId: string, cursor?: string, limit: number }
export type UpdateConversationParams = ConversationIdentifier & { request: UpdateAgentConversationRequest }
export type SetMessageFeedbackParams = ConversationIdentifier & { messageIndex: number, request: SetAgentMessageFeedbackRequest }
