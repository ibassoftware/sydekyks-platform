import { isDeepStrictEqual } from 'node:util'
import { ActivepiecesError, ErrorCode, isObject } from '@activepieces/core-utils'
import { AgentRunSource, agentToolClassification, ExecuteAgentToolRequest, ExecuteAgentToolResponse, FlowActionType, flowStructureUtil } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { flowService } from '../../../flows/flow/flow.service'
import { sydApprovalGate } from '../approval-gate'
import { sydConversationService } from '../conversation-service'
import { sydCopilotActions } from '../tools/copilot-actions'
import { sydRunOperations } from './run-operations'

async function approvedByHuman({ toolName, toolInput, conversationId, runId }: { toolName: string, toolInput: Record<string, unknown>, conversationId?: string, runId?: string }): Promise<boolean> {
    const { approvedGateId, ...requested } = toolInput
    if (typeof approvedGateId !== 'string') return false
    const decision = await sydApprovalGate.checkDecision({ gateId: approvedGateId })
    if (decision === 'pending' || !decision.approved || decision.approvedToolName !== toolName || decision.approvedConversationId !== conversationId || decision.approvedRunId !== runId || !decision.approvedInput || !isDeepStrictEqual(decision.approvedInput, requested)) return false
    return sydApprovalGate.consumeApproval({ gateId: approvedGateId })
}

export const sydToolExecutionRpc = (log: FastifyBaseLogger) => ({
    async executeAgentTool(input: ExecuteAgentToolRequest): Promise<ExecuteAgentToolResponse> {
        const { toolName, toolInput, conversationId, runId, platformId, userId } = input
        if (input.source !== AgentRunSource.CHAT) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'Syd tools require CHAT' } })
        if (AGENT_MUTATIONS.has(toolName) && await sydRunOperations.turnHasRead({ conversationId: conversationId ?? '', runId }) && !await approvedByHuman({ toolName, toolInput, conversationId, runId })) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'A saved-agent change after reading data needs explicit approval' } })
        if (toolName === '__cancel_check') return { result: typeof toolInput.conversationId === 'string' ? await sydApprovalGate.isCancelled({ conversationId: toolInput.conversationId, runId: typeof toolInput.runId === 'string' ? toolInput.runId : undefined }) : false }
        if (toolName === '__approval_wait') return { result: typeof toolInput.gateId === 'string' ? await sydApprovalGate.waitForDecision({ gateId: toolInput.gateId, timeoutMs: Math.max(0, Math.min(typeof toolInput.timeoutMs === 'number' ? toolInput.timeoutMs : 50_000, 50_000)) }) : 'pending' }
        if (toolName === '__store_pending_gate') {
            if (typeof toolInput.conversationId === 'string' && typeof toolInput.gateId === 'string' && typeof toolInput.toolName === 'string') await sydApprovalGate.storePendingGate({ conversationId: toolInput.conversationId, gate: {
                gateId: toolInput.gateId, toolName: toolInput.toolName, displayName: typeof toolInput.displayName === 'string' ? toolInput.displayName : toolInput.toolName,
                toolInput: isObject(toolInput.toolInput) ? toolInput.toolInput : {}, ...(typeof toolInput.runId === 'string' ? { runId: toolInput.runId } : {}),
            } })
            return { result: { success: true } }
        }
        if (toolName === '__store_selected_connection') {
            if (conversationId && typeof toolInput.pieceName === 'string' && typeof toolInput.connectionExternalId === 'string') {
                await sydApprovalGate.storeSelectedConnection({ conversationId, pieceName: toolInput.pieceName, externalId: toolInput.connectionExternalId, label: typeof toolInput.label === 'string' ? toolInput.label : toolInput.connectionExternalId, projectId: typeof toolInput.projectId === 'string' ? toolInput.projectId : '' })
                await sydRunOperations.pinConnectionToAgent({ conversationId, platformId, userId, pieceName: toolInput.pieceName, externalId: toolInput.connectionExternalId, log })
            }
            return { result: { success: true } }
        }
        if (toolName === '__get_selected_connection') return { result: conversationId && typeof toolInput.pieceName === 'string' ? await sydApprovalGate.getSelectedConnection({ conversationId, pieceName: toolInput.pieceName }) : null }
        if (toolName === '__get_available_connections') return { result: conversationId && typeof toolInput.pieceName === 'string' ? await sydApprovalGate.getAvailableConnections({ conversationId, pieceName: toolInput.pieceName }) : [] }
        if (toolName === '__flow_write_check') {
            if (!conversationId || typeof toolInput.flowId !== 'string') return { result: { hasWrites: false } }
            const conversation = await sydConversationService(log).getConversationOrThrow({ id: conversationId, platformId, userId })
            if (!conversation.projectId) return { result: { hasWrites: false } }
            const flow = await flowService(log).getOnePopulated({ id: toolInput.flowId, projectId: conversation.projectId })
            if (!flow) return { result: { hasWrites: false } }
            const writeSteps = flowStructureUtil.getAllSteps(flow.version.trigger).filter((step) => step.type === FlowActionType.PIECE && typeof step.settings.actionName === 'string' && agentToolClassification.isWriteActionName(step.settings.actionName)).map((step) => step.displayName)
            return { result: { hasWrites: writeSteps.length > 0, flowName: flow.version.displayName, writeSteps } }
        }
        return { result: await sydCopilotActions.executeCrossProjectTool({ toolName, toolInput, conversationId, platformId, userId, log }) }
    },
})

export const sydToolApproval = { approvedByHuman }

const AGENT_MUTATIONS = new Set(['ap_create_agent', 'ap_update_agent', 'ap_add_agent_tool', 'ap_remove_agent_tool'])
