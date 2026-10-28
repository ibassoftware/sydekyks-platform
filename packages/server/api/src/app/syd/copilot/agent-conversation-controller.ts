import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { AgentConfig, AgentConversationStatus, AgentRunSource, CreateAgentConversationRequest, ListAgentRunsRequest, Permission, PrincipalType, SendAgentMessageRequest, SetAgentMessageFeedbackRequest, UpdateAgentConversationRequest } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { Order } from '../../helper/pagination/paginator'
import { HOSTED_AI_REQUEST_MAX_BYTES } from '../../hosting/hosting-ai-policy'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { HostedChatContent } from '../../hosting/hosting-copilot'
import { sydAgentConnections } from './agent-connections'
import { sydAgentRuntime } from './agent-runtime'
import { sydApprovalGate } from './approval-gate'
import { sydConversationHistory } from './history/conversation-history'
import { SydAgentConversationEntity } from './models/agent-conversation.entity'
import { sydChatAgentAdministration } from './tools/chat-agent-administration'

export const sydAgentConversationController: FastifyPluginAsyncZod = async (app) => {
    const hosted = hostingConfiguration.getServiceMode() === 'hosted'
    app.post('/conversations', { config: userConfig, schema: { body: CreateAgentConversationRequest } }, async (request, reply) => {
        return reply.code(201).send(await sydAgentRuntime.create({ ...actor(request), agentId: request.body.agentId, projectId: request.body.projectId, builder: request.body.builder ?? false, log: request.log }))
    })
    app.get('/conversations', { config: userConfig, schema: { querystring: z.object({ agentId: z.string(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }) } }, async (request) => {
        const scope = actor(request)
        const ids = await sydAgentRuntime.repo().find({ where: { ...scope, agentId: request.query.agentId, source: AgentRunSource.AGENT }, select: ['id'] })
        if (ids[0]) await sydAgentRuntime.get({ ...scope, id: ids[0].id, log: request.log })
        return paginate({ scope: { ...scope, agentId: request.query.agentId, source: AgentRunSource.AGENT }, cursor: request.query.cursor, limit: request.query.limit })
    })
    app.get('/conversations/:id', { config: userConfig, schema: { params } }, async (request) => owned(request))
    app.get('/conversations/:id/messages', { config: userConfig, schema: { params } }, async (request) => {
        const row = await owned(request)
        return { data: row.uiMessages ?? sydConversationHistory.reconstruct(row.messages) }
    })
    app.post('/conversations/:id', { config: userConfig, schema: { params, body: UpdateAgentConversationRequest } }, async (request) => {
        const row = await owned(request)
        await sydAgentRuntime.repo().update({ id: row.id, ...actor(request) }, request.body)
        return { ...row, ...request.body }
    })
    app.delete('/conversations/:id', { config: userConfig, schema: { params } }, async (request, reply) => {
        const row = await owned(request)
        await sydApprovalGate.requestCancel({ conversationId: row.id, runId: row.activeRunId ?? undefined })
        await sydApprovalGate.clearPendingGate({ conversationId: row.id })
        await sydAgentRuntime.repo().delete({ id: row.id, ...actor(request) })
        return reply.code(204).send()
    })
    app.post('/conversations/:id/messages', { config: userConfig, ...(hosted ? { bodyLimit: HOSTED_AI_REQUEST_MAX_BYTES } : {}), schema: { params, body: hosted ? SendAgentMessageRequest.safeExtend({ content: HostedChatContent }) : SendAgentMessageRequest } }, async (request) => {
        const row = await owned(request)
        if (!row.projectId) throw unavailable(row.id)
        const agent = row.agentId ? await sydChatAgentAdministration(request.log).getOneOrThrow({ id: row.agentId, projectId: row.projectId, userId: row.userId }) : null
        if (!agent && row.source !== AgentRunSource.AGENT_BUILDER) throw unavailable(row.id)
        return sydAgentRuntime.start({ conversation: row, config: agent?.draft ?? AgentConfig.parse({ instructions: '' }), content: request.body.content, files: request.body.files, nativeFileIds: request.body.nativeFileIds, nativeWebSearch: request.body.nativeWebSearch, modelName: row.source === AgentRunSource.AGENT_BUILDER ? row.modelName : undefined, tokenVersion: request.principal.type === PrincipalType.USER ? request.principal.tokenVersion ?? null : undefined, log: request.log })
    })
    app.post('/conversations/:id/cancel', { config: userConfig, schema: { params } }, async (request) => {
        const row = await owned(request)
        await sydApprovalGate.requestCancel({ conversationId: row.id, runId: row.activeRunId ?? undefined })
        await sydAgentRuntime.repo().update({ id: row.id, ...actor(request), ...(row.activeRunId ? { activeRunId: row.activeRunId } : {}) }, { status: AgentConversationStatus.IDLE })
        await sydApprovalGate.clearPendingGate({ conversationId: row.id, runId: row.activeRunId })
        return { success: true }
    })
    app.get('/conversations/:id/pending-gate', { config: userConfig, schema: { params } }, async (request) => {
        const row = await owned(request)
        return (await sydApprovalGate.getPendingGates({ conversationId: row.id })).find((gate) => !gate.runId || gate.runId === row.activeRunId) ?? null
    })
    app.post('/tool-approvals/:gateId', { config: userConfig, schema: { params: z.object({ gateId: z.string() }), body: z.object({ approved: z.boolean(), payload: z.record(z.string(), z.unknown()).optional() }) } }, async (request) => {
        const id = await sydApprovalGate.conversationIdForGate({ gateId: request.params.gateId })
        if (!id) throw unavailable(request.params.gateId)
        await sydAgentRuntime.get({ ...actor(request), id, log: request.log })
        await sydApprovalGate.resolveGate({ gateId: request.params.gateId, ...request.body, log: request.log })
        return { success: true }
    })
    app.get('/conversations/:id/connections', { config: userConfig, schema: { params, querystring: z.object({ pieceName: z.string() }) } }, async (request) => {
        const row = await owned(request)
        return { connections: await sydAgentConnections.available({ conversation: row, pieceName: request.query.pieceName, log: request.log }), reconnectOnly: false }
    })
    app.post('/conversations/:id/messages/:messageIndex/feedback', { config: userConfig, schema: { params: params.extend({ messageIndex: z.coerce.number().int().nonnegative() }), body: SetAgentMessageFeedbackRequest } }, async (request) => {
        const row = await owned(request)
        const message = row.uiMessages?.[request.params.messageIndex]
        if (!message || message.role !== 'assistant') throw unavailable(row.id)
        const path = [String(request.params.messageIndex), 'feedback']
        await sydAgentRuntime.repo().createQueryBuilder().update().set({ uiMessages: () => request.body.rating === null ? '"uiMessages" #- :path::text[]' : 'jsonb_set("uiMessages", :path::text[], :feedback::jsonb, true)' }).where({ id: row.id, ...actor(request) }).andWhere('"uiMessages"->CAST(:index AS integer)->>\'role\' = :role', { index: request.params.messageIndex, role: 'assistant' }).setParameters({ path, feedback: JSON.stringify(request.body) }).execute()
        return { success: true }
    })
    app.get('/conversations/runs', { config: runConfig, schema: { querystring: ListAgentRunsRequest } }, async (request) => {
        await sydChatAgentAdministration(request.log).getOneOrThrow({ id: request.query.agentId, projectId: request.projectId, userId: request.principal.id })
        return paginate({ scope: { platformId: request.principal.platform.id, projectId: request.projectId, agentId: request.query.agentId, source: AgentRunSource.FLOW_STEP }, cursor: request.query.cursor, limit: request.query.limit ?? 20 })
    })
    app.get('/conversations/runs/:id', { config: runConfig, schema: { params, querystring: z.object({ projectId: z.string() }) } }, async (request) => {
        const row = await sydAgentRuntime.repo().findOneBy({ id: request.params.id, platformId: request.principal.platform.id, projectId: request.projectId, source: AgentRunSource.FLOW_STEP })
        if (!row?.agentId) throw unavailable(request.params.id)
        await sydChatAgentAdministration(request.log).getOneOrThrow({ id: row.agentId, projectId: request.projectId, userId: request.principal.id })
        return row
    })
}

async function owned(request: Pick<FastifyRequest, 'principal' | 'log'> & { params: { id: string } }) {
    return sydAgentRuntime.get({ ...actor(request), id: request.params.id, log: request.log })
}
function actor(request: Pick<FastifyRequest, 'principal'>) {
    if (request.principal.type !== PrincipalType.USER) throw unavailable('user')
    return { platformId: request.principal.platform.id, userId: request.principal.id }
}
async function paginate({ scope, cursor, limit }: { scope: { platformId: string, userId?: string, projectId?: string, agentId: string, source: AgentRunSource }, cursor?: string, limit: number }) {
    const decoded = paginationHelper.decodeCursor(cursor)
    const paginator = buildPaginator({ entity: SydAgentConversationEntity, query: { limit, orderBy: [{ field: 'created', order: Order.DESC }, { field: 'id', order: Order.DESC }], afterCursor: decoded.nextCursor, beforeCursor: decoded.previousCursor } })
    const query = sydAgentRuntime.repo().createQueryBuilder('agent_conversation').select(['id', 'created', 'updated', 'platformId', 'projectId', 'userId', 'agentId', 'flowRunId', 'source', 'title', 'modelName', 'status', 'aiCredits'].map((field) => `agent_conversation.${field}`)).where(scope)
    const result = await paginator.paginate(query)
    return paginationHelper.createPage(result.data, result.cursor)
}
function unavailable(id: string) {
    return new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityType: 'AgentConversation', entityId: id } })
}
const userConfig = { security: securityAccess.publicPlatform([PrincipalType.USER]) }
const runConfig = { security: securityAccess.project([PrincipalType.USER], Permission.READ_AGENT, { type: ProjectResourceType.QUERY }) }
const params = z.object({ id: z.string() })
