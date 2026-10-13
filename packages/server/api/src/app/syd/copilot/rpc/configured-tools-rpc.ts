import { isDeepStrictEqual } from 'node:util'
import { ActivepiecesError, connectionTemplate, ErrorCode } from '@activepieces/core-utils'
import { aiUtils } from '@activepieces/server-utils'
import { AGENT_SELF_EDIT_TOOLS, AGENT_SURFACE_TOOLS, AgentActionKind, AgentRunSource, AgentToolType, AI_PROVIDER_CAPABILITIES, ExecuteAgentToolRequest, ExecuteAgentToolResponse, ExecuteFlowToolRequest, ExecuteKnowledgeBaseToolRequest, ExecutePieceToolRequest, KnowledgeBaseSourceType, Permission, ResumeFlowStepRequest, UpdateFlowStepProgressRequest } from '@activepieces/shared'
import { embed } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { IsNull } from 'typeorm'
import { flowService } from '../../../flows/flow/flow.service'
import { engineRunCallbackService } from '../../../flows/flow-run/engine-run-callback-service'
import { flowRunService } from '../../../flows/flow-run/flow-run-service'
import { knowledgeBaseService } from '../../../knowledge-base/knowledge-base.service'
import { resolvePermissionChecker } from '../../../mcp/mcp-permissions'
import { extractMcpTriggerInput, runFlowAsTool } from '../../../mcp/mcp-server-builder'
import { resumeService } from '../../../waitpoints/resume-service'
import { waitpointService } from '../../../waitpoints/waitpoint-service'
import { sydAgentConnections } from '../agent-connections'
import { sydAgentRuntime } from '../agent-runtime'
import { sydApprovalGate } from '../approval-gate'
import { sydCopilotContext } from '../copilot-context'
import { sydChatAgentAdministration } from '../tools/chat-agent-administration'
import { sydChatAgentTools } from '../tools/chat-agent-tools'
import { sydConfiguredPiece } from '../tools/configured-piece'
import { sydConfiguredTable } from '../tools/configured-table'
import { sydRunOperations } from './run-operations'
import { sydToolApproval } from './tool-execution-rpc'

export const sydConfiguredToolsRpc = (log: FastifyBaseLogger) => ({
    async executePieceTool(input: ExecutePieceToolRequest) {
        const run = await sydAgentRuntime.snapshot(input)
        const configured = run.config.tools.find((tool) => tool.toolName === input.toolName)
        if (configured?.type !== AgentToolType.PIECE || !isDeepStrictEqual(configured.pieceMetadata, input.piece)) throw denied()
        const model = await sydCopilotContext.resolveFastModel({ platformId: run.platformId, provider: run.config.provider ?? undefined, providerConfigId: run.config.providerConfigId ?? undefined, surface: 'flow', scope: { type: 'project', projectId: run.projectId }, fallbackModelId: input.modelId, log })
        await sydRunOperations.markTurnAsHavingRead(input)
        const result = await sydConfiguredPiece.execute({ piece: configured.pieceMetadata, instruction: input.instruction, model, platformId: run.platformId, projectId: run.projectId, log })
        sydRunOperations.recordAgentToolUse({ run: { platformId: run.platformId, projectId: run.projectId, userId: run.userId, source: run.source }, conversationId: input.conversationId, action: { kind: AgentActionKind.PIECE, pieceName: configured.pieceMetadata.pieceName, pieceDisplayName: configured.pieceMetadata.pieceName, actionName: configured.pieceMetadata.actionName, displayName: result.actionDisplayName }, outcome: sydRunOperations.outcomeOfToolResult(result.result), connection: { externalId: connectionTemplate.unwrapExternalId(configured.pieceMetadata.predefinedInput?.auth) ?? undefined, label: result.connectionLabel }, log })
        return result
    },
    async executeFlowTool(input: ExecuteFlowToolRequest) {
        const run = await sydAgentRuntime.snapshot(input)
        const tool = run.flowTools.find((candidate) => candidate.toolName === input.toolName)
        if (!tool || tool.flowId !== input.flowId || tool.flowVersionId !== input.flowVersionId || tool.returnsResponse !== input.returnsResponse) throw denied()
        const flow = await flowService(log).getOnePopulated({ id: tool.flowId, projectId: run.projectId, versionId: tool.flowVersionId })
        if (!flow) throw denied()
        await sydRunOperations.markTurnAsHavingRead(input)
        const result = await runFlowAsTool({ flow, properties: extractMcpTriggerInput(flow).mcpInputs, payload: input.toolInput, returnsResponse: tool.returnsResponse, log })
        sydRunOperations.recordAgentToolUse({ run: { platformId: run.platformId, projectId: run.projectId, userId: run.userId, source: run.source }, conversationId: input.conversationId, action: { kind: AgentActionKind.FLOW, flowId: flow.id, displayName: flow.version.displayName }, ...(tool.returnsResponse ? { outcome: sydRunOperations.outcomeOfToolResult(result) } : {}), connection: {}, log })
        return { result }
    },
    async executeKnowledgeBaseTool(input: ExecuteKnowledgeBaseToolRequest) {
        const run = await sydAgentRuntime.snapshot(input)
        const tool = run.config.tools.find((candidate) => candidate.toolName === input.toolName)
        if (tool?.type !== AgentToolType.KNOWLEDGE_BASE || tool.sourceId !== input.knowledgeBaseFileId) throw denied()
        if (tool.sourceType === KnowledgeBaseSourceType.TABLE) {
            const model = await sydCopilotContext.resolveFastModel({ platformId: run.platformId, provider: run.config.provider ?? undefined, providerConfigId: run.config.providerConfigId ?? undefined, surface: 'flow', scope: { type: 'project', projectId: run.projectId }, fallbackModelId: run.config.modelName ?? undefined, log })
            await sydRunOperations.markTurnAsHavingRead(input)
            return { result: await sydConfiguredTable.search({ tableId: tool.sourceId, projectId: run.projectId, userId: run.userId, query: input.query, model, log }) }
        }
        const service = knowledgeBaseService(log)
        await service.getFileOrThrow({ projectId: run.projectId, id: tool.sourceId })
        const credentials = await sydCopilotContext.resolveRunProvider({ platformId: run.platformId, provider: run.config.provider ?? undefined, providerConfigId: run.config.providerConfigId ?? undefined, scope: { type: 'project', projectId: run.projectId }, log })
        const modelId = AI_PROVIDER_CAPABILITIES[credentials.provider].defaultEmbeddingModel
        if (!modelId || (credentials.modelScope === 'selected' && !credentials.modelIds.includes(modelId))) throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityType: 'AIProvider', entityId: credentials.provider } }, 'This key has no allowed embedding model for knowledge search')
        const embedding = aiUtils.createEmbeddingModel({ credentials, platformId: run.platformId, providerConfigId: credentials.configId })
        await service.embedMissingChunks({ projectId: run.projectId, knowledgeBaseFileId: tool.sourceId, resolveEmbedFn: async () => service.embedFnOf(embedding) })
        if (!await service.isSearchable({ projectId: run.projectId, knowledgeBaseFileId: tool.sourceId })) return { result: 'The attached file could not be indexed. Its contents have not been read.' }
        await sydRunOperations.markTurnAsHavingRead(input)
        const query = await embed({ model: embedding.model, value: input.query, providerOptions: embedding.providerOptions })
        return { result: await service.search({ projectId: run.projectId, knowledgeBaseFileIds: [tool.sourceId], queryEmbedding: aiUtils.toStorageEmbedding(query.embedding), limit: 5, similarityThreshold: 0.3 }) }
    },
    async executeAgentTool(input: ExecuteAgentToolRequest): Promise<ExecuteAgentToolResponse> {
        const conversationId = input.conversationId ?? (typeof input.toolInput.conversationId === 'string' ? input.toolInput.conversationId : undefined)
        if (!conversationId) throw denied()
        const runId = input.runId ?? (typeof input.toolInput.runId === 'string' ? input.toolInput.runId : undefined)
        const row = await sydRunOperations.conversationForRpc({ conversationId, platformId: input.platformId })
        if (row.userId !== input.userId || row.source !== input.source || row.source === AgentRunSource.CHAT || !row.projectId) throw denied()
        if (runId && row.activeRunId !== runId) throw denied()
        const { toolName, toolInput } = input
        if (toolName === '__cancel_check') return { result: await sydApprovalGate.isCancelled({ conversationId: row.id, runId }) }
        if (toolName === '__approval_wait' && typeof toolInput.gateId === 'string') {
            const id = await sydApprovalGate.conversationIdForGate({ gateId: toolInput.gateId })
            const decision = await sydApprovalGate.checkDecision({ gateId: toolInput.gateId })
            if (id !== row.id && (decision === 'pending' || decision.approvedConversationId !== row.id || decision.approvedRunId !== runId)) throw denied()
            return { result: await sydApprovalGate.waitForDecision({ gateId: toolInput.gateId, timeoutMs: 50000 }) }
        }
        if (row.source === AgentRunSource.FLOW_STEP) throw denied()
        if (toolName === '__store_pending_gate' && typeof toolInput.gateId === 'string' && typeof toolInput.toolName === 'string') {
            const nested = toolInput.toolInput
            await sydApprovalGate.storePendingGate({ conversationId: row.id, gate: { gateId: toolInput.gateId, toolName: toolInput.toolName, displayName: typeof toolInput.displayName === 'string' ? toolInput.displayName : toolInput.toolName, toolInput: isRecord(nested) ? nested : {}, ...(runId ? { runId } : {}) } })
            return { result: { success: true } }
        }
        if (toolName === '__get_selected_connection' && typeof toolInput.pieceName === 'string') return { result: await sydApprovalGate.getSelectedConnection({ conversationId: row.id, pieceName: toolInput.pieceName }) }
        if (toolName === '__get_available_connections' && typeof toolInput.pieceName === 'string') return { result: await sydAgentConnections.available({ conversation: row, pieceName: toolInput.pieceName, log }) }
        if (toolName === '__store_selected_connection' && typeof toolInput.pieceName === 'string' && typeof toolInput.connectionExternalId === 'string') {
            await sydAgentConnections.select({ conversation: row, pieceName: toolInput.pieceName, externalId: toolInput.connectionExternalId, log })
            return { result: { success: true } }
        }
        const allowed = row.source === AgentRunSource.AGENT_BUILDER ? AGENT_SURFACE_TOOLS : AGENT_SELF_EDIT_TOOLS
        if (!allowed.includes(toolName)) throw denied()
        const checker = await resolvePermissionChecker({ userId: row.userId, projectId: row.projectId, log })
        const refusal = checker.check(toolName === 'ap_list_agents' ? Permission.READ_AGENT : Permission.WRITE_AGENT, toolName)
        if (refusal) return { result: refusal }
        if (toolName !== 'ap_list_agents' && await sydRunOperations.turnHasRead({ conversationId: row.id, runId }) && !await sydToolApproval.approvedByHuman({ toolName, toolInput, conversationId: row.id, runId })) throw denied()
        const params = { toolInput, projectId: row.projectId, platformId: row.platformId, userId: row.userId, log }
        const service = sydChatAgentAdministration(log)
        if (toolName === 'ap_list_agents') return { result: (await service.list({ ...params, limit: 50 })).data }
        if (toolName === 'ap_create_agent' && row.source === AgentRunSource.AGENT_BUILDER && !row.agentId) {
            const result = await sydChatAgentTools.createAgentFromChat(params)
            if (isRecord(result) && typeof result.agentId === 'string') await sydAgentRuntime.repo().update({ id: row.id, platformId: row.platformId, userId: row.userId, projectId: row.projectId, source: AgentRunSource.AGENT_BUILDER, agentId: IsNull(), ...(runId ? { activeRunId: runId } : {}) }, { agentId: result.agentId })
            return { result }
        }
        if (toolName === 'ap_create_agent') throw denied()
        if (!row.agentId || (typeof toolInput.agentId === 'string' && toolInput.agentId !== row.agentId)) throw denied()
        const agent = await service.getOneOrThrow({ id: row.agentId, projectId: row.projectId, userId: row.userId })
        const edit = { ...params, agent }
        return { result: toolName === 'ap_update_agent' ? await sydChatAgentTools.updateAgentFromChat(edit) : toolName === 'ap_add_agent_tool' ? await sydChatAgentTools.addAgentToolFromChat(edit) : await sydChatAgentTools.removeAgentToolFromChat(edit) }
    },
    async updateFlowStepProgress(input: UpdateFlowStepProgressRequest): Promise<void> {
        const row = await flowConversation({ conversationId: input.conversationId, flowRunId: input.flowRunId })
        await flowRunService(log).getOneOrThrow({ id: input.flowRunId, projectId: row.projectId })
        engineRunCallbackService(log).updateStepProgress({ projectId: row.projectId, request: { projectId: row.projectId, runId: input.flowRunId, output: input.output, sequence: input.sequence } })
    },
    async resumeFlowStep(input: ResumeFlowStepRequest): Promise<void> {
        const row = await flowConversation({ conversationId: input.conversationId, flowRunId: input.flowRunId })
        const run = await sydAgentRuntime.snapshot({ conversationId: row.id })
        if (run.waitpointId !== input.waitpointId) throw denied()
        const point = await waitpointService(log).findByIdAndFlowRunId({ waitpointId: input.waitpointId, flowRunId: input.flowRunId, projectId: row.projectId })
        if (!point) throw denied()
        await resumeService(log).resumeFromWaitpoint({ flowRunId: input.flowRunId, waitpointId: input.waitpointId, resumePayload: { body: input.output, headers: {}, queryParams: {} } })
    },
})

async function flowConversation({ conversationId, flowRunId }: { conversationId: string, flowRunId: string }) {
    const run = await sydAgentRuntime.snapshot({ conversationId })
    const row = await sydAgentRuntime.repo().findOneBy({ id: conversationId, platformId: run.platformId, projectId: run.projectId, source: AgentRunSource.FLOW_STEP, flowRunId })
    if (!row || !row.projectId) throw denied()
    return { ...row, projectId: row.projectId }
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) 
}
function denied() {
    return new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'This operation is not part of the configured agent run' } }) 
}
