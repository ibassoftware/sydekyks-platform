import { ActivepiecesError, AIProviderName, apId, ErrorCode, tryCatch } from '@activepieces/core-utils'
import { AgentConversation, AgentConversationStatus, AgentRunSource, CreateAgentConversationRequest, ImportAgentMemoryRequest, InstructAgentMemoryRequest, LATEST_JOB_DATA_SCHEMA_VERSION, PrincipalType, SendAgentMessageRequest, SERVICE_KEY_SECURITY_OPENAPI, SetAgentMessageFeedbackRequest, UpdateAgentConversationRequest, UpdateAgentMemoryRequest, WorkerJobType } from '@activepieces/shared'
import { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { IsNull } from 'typeorm'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { assertHostedChatContext, hostedCopilotPayer } from '../../hosting/hosting-copilot'
import { hostingFail } from '../../hosting/hosting-transactions'
import { mcpUtils } from '../../mcp/tools/mcp-utils'
import { assertCreditsAndAppSumoNotExceeded } from '../../platform/billing-provider'
import { jobQueue, JobType } from '../../workers/job-queue/job-queue'
import { sydApprovalGate } from './approval-gate'
import { sydChatModelCatalog } from './chat-model-catalog'
import { sydConversationService } from './conversation-service'
import { ActorScope, sydCopilotContext } from './copilot-context'
import { sydEditorContext } from './editor-context'
import { sydMemoryEditor } from './memory-editor'
import { sydCopilotActions } from './tools/copilot-actions'

async function sendMessage({ platformId, userId, id, body, log, tokenVersion }: ActorScope & { id: string, body: SydSendMessageRequest, log: FastifyBaseLogger, tokenVersion?: string | null }): Promise<{ conversationId: string, runId: string }> {
    const conversation = await sydConversationService(log).getConversationOrThrow({ platformId, userId, id })
    const editor = body.editorContext ? await sydEditorContext.getForUser({ platformId, userId, context: body.editorContext, log }) : null
    if (editor && editor.projectId !== conversation.projectId) await sydCopilotContext.assertProjectSwitchKeepsKey({ platformId, fromProjectId: conversation.projectId ?? null, toProjectId: editor.projectId, log })
    await assertAgentMessageRateLimitNotExceeded({ platformId, userId, log })
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    const hosted = hostingConfiguration.getServiceMode() === 'hosted'
    if (hosted) assertHostedChatContext({ messages: conversation.messages, content: body.content })
    const projectId = hosted && body.hostedProjectId ? body.hostedProjectId : sydCopilotContext.selectRunProject({ conversationProjectId: editor?.projectId ?? conversation.projectId ?? null, projects })
    if (hosted && (!projectId || !projects.some(project => project.id === projectId) || (body.hostedProjectId && ((conversation.projectId && conversation.projectId !== projectId) || (editor && editor.projectId !== projectId))))) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
    const payer = hosted ? await hostedCopilotPayer({ platformId, projectId: projectId!, provider: body.hostedPayer?.type === 'byok' ? AIProviderName.DEEPSEEK : AIProviderName.ACTIVEPIECES, configId: body.hostedPayer?.type === 'byok' ? body.hostedPayer.configId : undefined }) : undefined
    if (hosted && body.files?.length) throw new Error('HOSTING_TOOL_NOT_METERED')
    if (!hosted) await sydCopilotContext.assertRunProviderConfigured({ platformId, scope: sydCopilotContext.runScopeOrThrow({ projectId }), log })
    if (!hosted) await assertCreditsAndAppSumoNotExceeded({ platformId, log })
    const runId = hostingConfiguration.getServiceMode() === 'hosted' ? apId() : body.runId ?? apId()
    const claim = await sydCopilotContext.claimConversationForRun({ platformId, userId, conversationId: id, runId })
    if ((editor || (hosted && body.hostedProjectId)) && projectId !== conversation.projectId) {
        const changed = await sydCopilotContext.conversationRepo().update({ id, platformId, userId, activeRunId: runId, source: AgentRunSource.CHAT }, { projectId })
        if (!changed.affected) throw new ActivepiecesError({ code: ErrorCode.AGENT_RUN_SUPERSEDED, params: { message: 'This message was replaced by a newer one' } })
    }
    if (claim.preemptedRunId) {
        await sydApprovalGate.requestCancel({ conversationId: id, runId: claim.preemptedRunId })
        await sydApprovalGate.clearPendingGate({ conversationId: id, runId: claim.preemptedRunId })
    }
    await jobQueue(log).add({ id: hostingConfiguration.getServiceMode() === 'hosted' ? runId : apId(), type: JobType.ONE_TIME, hostedOrigin: { type: 'user', userId, tokenVersion }, data: {
        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_AGENT_RUN,
        platformId, userId, projectId, conversationId: id, runId,
        ...(payer ? { provider: payer.type === 'managed' ? AIProviderName.ACTIVEPIECES : AIProviderName.DEEPSEEK, ...(payer.type === 'byok' ? { providerConfigId: payer.configId } : {}) } : {}),
        userMessage: body.content, modelName: conversation.modelName ?? null, files: body.files, source: AgentRunSource.CHAT, messageSource: body.messageSource, editorContext: body.editorContext,
    } })
    return { conversationId: id, runId }
}

async function decideToolApproval({ platformId, userId, gateId, body, log }: ActorScope & { gateId: string, body: { approved: boolean, payload?: Record<string, unknown> }, log: FastifyBaseLogger }): Promise<{ success: boolean }> {
    const id = await sydApprovalGate.conversationIdForGate({ gateId })
    if (id) await sydConversationService(log).getConversationOrThrow({ id, platformId, userId })
    await sydApprovalGate.resolveGate({ gateId, ...body, log })
    return { success: true }
}

async function cancelConversation({ id, platformId, userId, log }: ActorScope & { id: string, log: FastifyBaseLogger }): Promise<{ success: boolean }> {
    const row = await sydConversationService(log).getConversationOrThrow({ id, platformId, userId })
    await sydApprovalGate.requestCancel({ conversationId: id, runId: row.activeRunId ?? undefined })
    const result = await sydCopilotContext.conversationRepo().createQueryBuilder().update().set({ status: AgentConversationStatus.IDLE })
        .where({ id, platformId, userId, activeRunId: row.activeRunId ?? IsNull() }).returning('id').execute()
    if (Array.isArray(result.raw) && result.raw.length) await sydApprovalGate.clearPendingGate({ conversationId: id, runId: row.activeRunId })
    return { success: true }
}

async function getPendingDecision({ id, platformId, userId, log }: ActorScope & { id: string, log: FastifyBaseLogger }) {
    const row = await sydConversationService(log).getConversationOrThrow({ id, platformId, userId })
    return (await sydApprovalGate.getPendingGates({ conversationId: id })).find((gate) => !row.activeRunId || !gate.runId || gate.runId === row.activeRunId) ?? null
}

async function pinnedAccounts({ conversation }: { conversation: AgentConversation }): Promise<null> {
    if (conversation.source !== AgentRunSource.CHAT) throw new Error('Syd connection offers require CHAT')
    return null
}
function connectionOffer<T>({ connections }: { connections: T[], pinned: null }): { connections: T[], reconnectOnly: boolean } {
    return { connections, reconnectOnly: false }
}
function normalizePiece(pieceName: string): string {
    return mcpUtils.normalizePieceName(pieceName) ?? pieceName
}

async function listEligibleConnections({ id, platformId, userId, pieceName, log }: ActorScope & { id: string, pieceName: string, log: FastifyBaseLogger }) {
    const conversation = await sydConversationService(log).getConversationOrThrow({ id, platformId, userId })
    const pinned = await pinnedAccounts({ conversation })
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    const found = await tryCatch(() => sydCopilotActions.findConnectionsForPiece({ projects, platformId, pieceName, log }))
    const key = normalizePiece(pieceName)
    if (!found.data) return connectionOffer({ connections: await sydApprovalGate.getAvailableConnections({ conversationId: id, pieceName: key }), pinned })
    const connections = 'pickConnection' in found.data ? found.data.connections : []
    await sydApprovalGate.storeAvailableConnections({ conversationId: id, pieceName: key, connections })
    return connectionOffer({ connections, pinned })
}

async function assertAgentMessageRateLimitNotExceeded({ platformId, userId }: ActorScope & { log: FastifyBaseLogger }): Promise<void> {
    const result = await sydCopilotContext.incrementAndCheckLimit({ key: `syd:chat-rate:v1:${platformId}:${userId}`, limit: 40, ttlSeconds: 600 })
    if (!result.allowed) throw new ActivepiecesError({ code: ErrorCode.CHAT_MESSAGE_LIMIT_EXCEEDED, params: { limit: 40, windowSeconds: 600 } })
}

function actor(request: Pick<FastifyRequest, 'log' | 'principal'>): ActorScope {
    if (request.principal.type !== PrincipalType.USER || !('platform' in request.principal)) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'Platform user is required' } })
    return { platformId: request.principal.platform.id, userId: request.principal.id }
}

const handlers = {
    createConversation: async ({ request, reply }: { request: HandlerRequest<CreateRoute>, reply: FastifyReply }) => reply.code(201).send(await sydConversationService(request.log).createConversation({ ...actor(request), request: request.body })),
    listConversations: async ({ request }: { request: HandlerRequest<ListConversationsRoute>, reply: FastifyReply }) => sydConversationService(request.log).listConversations({ ...actor(request), cursor: request.query.cursor, limit: request.query.limit ?? 20 }),
    getConversation: async ({ request }: { request: HandlerRequest<ConversationRoute>, reply: FastifyReply }) => sydConversationService(request.log).getConversationOrThrow({ ...actor(request), id: request.params.id }),
    updateConversation: async ({ request }: { request: HandlerRequest<UpdateRoute>, reply: FastifyReply }) => sydConversationService(request.log).updateConversation({ ...actor(request), id: request.params.id, request: request.body }),
    deleteConversation: async ({ request, reply }: { request: HandlerRequest<ConversationRoute>, reply: FastifyReply }) => {
        await sydConversationService(request.log).deleteConversation({ ...actor(request), id: request.params.id }); return reply.code(204).send()
    },
    getMessages: async ({ request }: { request: HandlerRequest<ConversationRoute>, reply: FastifyReply }) => sydConversationService(request.log).getMessages({ ...actor(request), id: request.params.id }),
    setMessageFeedback: async ({ request }: { request: HandlerRequest<SetMessageFeedbackRoute>, reply: FastifyReply }) => {
        await sydConversationService(request.log).setMessageFeedback({ ...actor(request), ...request.params, request: request.body }); return { success: true }
    },
    sendMessage: async ({ request }: { request: HandlerRequest<SendRoute>, reply: FastifyReply }) => sendMessage({ ...actor(request), id: request.params.id, body: request.body, log: request.log, tokenVersion: request.principal.type === PrincipalType.USER ? request.principal.tokenVersion ?? null : undefined }),
    decideToolApproval: async ({ request }: { request: HandlerRequest<ToolApprovalRoute>, reply: FastifyReply }) => decideToolApproval({ ...actor(request), gateId: request.params.gateId, body: request.body, log: request.log }),
    cancelConversation: async ({ request }: { request: HandlerRequest<ConversationRoute>, reply: FastifyReply }) => cancelConversation({ ...actor(request), id: request.params.id, log: request.log }),
    getPendingDecision: async ({ request }: { request: HandlerRequest<ConversationRoute>, reply: FastifyReply }) => getPendingDecision({ ...actor(request), id: request.params.id, log: request.log }),
    listEligibleConnections: async ({ request }: { request: HandlerRequest<GetPickerConnectionsRoute>, reply: FastifyReply }) => listEligibleConnections({ ...actor(request), id: request.params.id, pieceName: request.query.pieceName, log: request.log }),
    getMemory: async ({ request }: { request: HandlerRequest<MemoryRoute>, reply: FastifyReply }) => sydCopilotContext.getUserMemory(actor(request)),
    saveMemory: async ({ request }: { request: HandlerRequest<SaveMemoryRoute>, reply: FastifyReply }) => sydCopilotContext.saveUserMemory({ ...actor(request), ...request.body }),
    importMemory: async ({ request }: { request: HandlerRequest<ImportMemoryRoute>, reply: FastifyReply }) => {
        const scope = actor(request)
        const draft = await sydMemoryEditor.extract({ ...scope, text: request.body.text, log: request.log })
        const base = await sydCopilotContext.getUserMemory(scope)
        return sydCopilotContext.saveUserMemory({ ...scope, memories: [...base.memories, ...draft.memories], baseMemories: base.memories })
    },
    instructMemory: async ({ request }: { request: HandlerRequest<InstructMemoryRoute>, reply: FastifyReply }) => sydMemoryEditor.applyInstruction({ ...actor(request), instruction: request.body.instruction, log: request.log }),
}

const SydSendMessageRequest = SendAgentMessageRequest.safeExtend({ hostedProjectId: z.string().length(21).optional(), hostedPayer: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('managed') }), z.strictObject({ type: z.literal('byok'), configId: z.string().length(21) })]).optional(), editorContext: z.object({ flowId: z.string(), flowVersionId: z.string(), selectedStepName: z.string().optional() }).optional() })
type SydSendMessageRequest = z.infer<typeof SydSendMessageRequest>

const register: FastifyPluginAsyncZod = async (app) => {
    app.get('/models', { ...CONFIG, schema: { ...SCHEMA, querystring: z.object({ projectId: z.string() }), response: { 200: z.object({ provider: z.enum(AIProviderName), models: z.array(z.object({ id: z.string(), label: z.string() })), defaultModelId: z.string().nullable() }) } } }, async (request) => sydChatModelCatalog.getModels({ ...actor(request), projectId: request.query.projectId, log: request.log }))
    app.post('/conversations', { ...CONFIG, schema: { ...SCHEMA, body: CreateAgentConversationRequest } }, async (request, reply) => handlers.createConversation({ request, reply }))
    app.get('/conversations', ListConversationsRoute, async (request, reply) => handlers.listConversations({ request, reply }))
    app.get('/conversations/:id', CONVERSATION_ROUTE, async (request, reply) => handlers.getConversation({ request, reply }))
    app.post('/conversations/:id', { ...CONVERSATION_ROUTE, schema: { ...CONVERSATION_ROUTE.schema, body: UpdateAgentConversationRequest } }, async (request, reply) => handlers.updateConversation({ request, reply }))
    app.delete('/conversations/:id', CONVERSATION_ROUTE, async (request, reply) => handlers.deleteConversation({ request, reply }))
    app.get('/conversations/:id/messages', CONVERSATION_ROUTE, async (request, reply) => handlers.getMessages({ request, reply }))
    app.post('/conversations/:id/messages/:messageIndex/feedback', SetMessageFeedbackRoute, async (request, reply) => handlers.setMessageFeedback({ request, reply }))
    app.post('/conversations/:id/messages', { ...CONVERSATION_ROUTE, schema: { ...CONVERSATION_ROUTE.schema, body: SydSendMessageRequest } }, async (request, reply) => handlers.sendMessage({ request, reply }))
    app.post('/tool-approvals/:gateId', ToolApprovalRoute, async (request, reply) => handlers.decideToolApproval({ request, reply }))
    app.post('/conversations/:id/cancel', CONVERSATION_ROUTE, async (request, reply) => handlers.cancelConversation({ request, reply }))
    app.get('/conversations/:id/pending-gate', CONVERSATION_ROUTE, async (request, reply) => handlers.getPendingDecision({ request, reply }))
    app.get('/conversations/:id/connections', GetPickerConnectionsRoute, async (request, reply) => handlers.listEligibleConnections({ request, reply }))
    app.get('/memory', { ...CONFIG, schema: SCHEMA }, async (request, reply) => handlers.getMemory({ request, reply }))
    app.post('/memory', { ...CONFIG, schema: { ...SCHEMA, body: UpdateAgentMemoryRequest } }, async (request, reply) => handlers.saveMemory({ request, reply }))
    app.post('/memory/import', { ...CONFIG, schema: { ...SCHEMA, body: ImportAgentMemoryRequest } }, async (request, reply) => handlers.importMemory({ request, reply }))
    app.post('/memory/instruct', { ...CONFIG, schema: { ...SCHEMA, body: InstructAgentMemoryRequest } }, async (request, reply) => handlers.instructMemory({ request, reply }))
}

const PRINCIPALS: readonly PrincipalType.USER[] = [PrincipalType.USER]
const CONFIG = { config: { security: securityAccess.publicPlatform(PRINCIPALS) } }
const SCHEMA = { tags: ['syd-copilot'], security: [SERVICE_KEY_SECURITY_OPENAPI] }
export const CONVERSATION_PARAMS = z.object({ id: z.string() })
const CONVERSATION_ROUTE = { ...CONFIG, schema: { ...SCHEMA, params: CONVERSATION_PARAMS } }
export const ListConversationsRoute = { ...CONFIG, schema: { ...SCHEMA, querystring: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) } }
export const SetMessageFeedbackRoute = { ...CONFIG, schema: { ...SCHEMA, params: z.object({ id: z.string(), messageIndex: z.coerce.number().int().min(0) }), body: SetAgentMessageFeedbackRequest } }
export const ToolApprovalRoute = { ...CONFIG, schema: { ...SCHEMA, params: z.object({ gateId: z.string() }), body: z.object({ approved: z.boolean(), payload: z.record(z.string(), z.unknown()).optional() }) } }
export const GetPickerConnectionsRoute = { ...CONVERSATION_ROUTE, schema: { ...CONVERSATION_ROUTE.schema, querystring: z.object({ pieceName: z.string() }) } }

export const sydConversationController = { register, handlers, sendMessage, decideToolApproval, cancelConversation, getPendingDecision, pinnedAccounts, connectionOffer, normalizePiece, listEligibleConnections, assertAgentMessageRateLimitNotExceeded }

export type CONVERSATION_PARAMS = z.infer<typeof CONVERSATION_PARAMS>
export type ConversationRoute = { Params: CONVERSATION_PARAMS }
export type ListConversationsRoute = { Querystring: { cursor?: string, limit?: number } }
export type SetMessageFeedbackRoute = { Params: CONVERSATION_PARAMS & { messageIndex: number }, Body: SetAgentMessageFeedbackRequest }
export type ToolApprovalRoute = { Params: { gateId: string }, Body: { approved: boolean, payload?: Record<string, unknown> } }
export type GetPickerConnectionsRoute = ConversationRoute & { Querystring: { pieceName: string } }
export type PinnedAccounts = null
export type CreateRoute = { Body: CreateAgentConversationRequest }
export type UpdateRoute = ConversationRoute & { Body: UpdateAgentConversationRequest }
export type SendRoute = ConversationRoute & { Body: SydSendMessageRequest }
export type MemoryRoute = Record<string, never>
export type SaveMemoryRoute = { Body: UpdateAgentMemoryRequest }
export type ImportMemoryRoute = { Body: ImportAgentMemoryRequest }
export type InstructMemoryRoute = { Body: InstructAgentMemoryRequest }

type HandlerRequest<T> = Pick<FastifyRequest, 'log' | 'principal'> & (T extends { Params: infer P } ? { params: P } : unknown) & (T extends { Body: infer B } ? { body: B } : unknown) & (T extends { Querystring: infer Q } ? { query: Q } : unknown)
