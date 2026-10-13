import { ActivepiecesError, ErrorCode, Permission } from '@activepieces/core-utils'
import { AgentConversation, AgentToolType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { appConnectionService } from '../../app-connection/app-connection-service/app-connection-service'
import { resolvePermissionChecker } from '../../mcp/mcp-permissions'
import { mcpUtils } from '../../mcp/tools/mcp-utils'
import { sydApprovalGate } from './approval-gate'
import { sydCopilotContext } from './copilot-context'
import { sydChatAgentAdministration } from './tools/chat-agent-administration'
import { sydCopilotActions } from './tools/copilot-actions'

async function available({ conversation, pieceName, log }: { conversation: AgentConversation, pieceName: string, log: FastifyBaseLogger }) {
    if (!conversation.projectId) throw denied()
    const checker = await resolvePermissionChecker({ userId: conversation.userId, projectId: conversation.projectId, log })
    if (checker.check(Permission.READ_APP_CONNECTION, 'agent-connections')) throw denied()
    const projects = await sydCopilotContext.getUserProjects({ platformId: conversation.platformId, userId: conversation.userId, log })
    const found = await sydCopilotActions.findConnectionsForPiece({ projects: projects.filter((project) => project.id === conversation.projectId), platformId: conversation.platformId, pieceName, log })
    const connections = 'pickConnection' in found ? found.connections : []
    await sydApprovalGate.storeAvailableConnections({ conversationId: conversation.id, pieceName: mcpUtils.normalizePieceName(pieceName) ?? pieceName, connections })
    return connections
}

async function select({ conversation, pieceName, externalId, log }: { conversation: AgentConversation, pieceName: string, externalId: string, log: FastifyBaseLogger }): Promise<void> {
    if (!conversation.projectId) throw denied()
    const normalized = mcpUtils.normalizePieceName(pieceName) ?? pieceName
    const connection = await appConnectionService(log).getOneWithoutValue({ platformId: conversation.platformId, projectId: conversation.projectId, externalId })
    if (!connection || mcpUtils.normalizePieceName(connection.pieceName) !== normalized) throw denied()
    await sydApprovalGate.storeSelectedConnection({ conversationId: conversation.id, pieceName: normalized, externalId, label: connection.displayName, projectId: conversation.projectId })
    if (!conversation.agentId) return
    const checker = await resolvePermissionChecker({ userId: conversation.userId, projectId: conversation.projectId, log })
    if (checker.check(Permission.WRITE_AGENT, 'pin-agent-connection')) return
    await sydChatAgentAdministration(log).editDraftTools({ id: conversation.agentId, projectId: conversation.projectId, userId: conversation.userId, edit: (tools) => tools.map((tool) => tool.type === AgentToolType.PIECE && mcpUtils.normalizePieceName(tool.pieceMetadata.pieceName) === normalized ? { ...tool, pieceMetadata: { ...tool.pieceMetadata, predefinedInput: { ...tool.pieceMetadata.predefinedInput, fields: tool.pieceMetadata.predefinedInput?.fields ?? {}, auth: externalId } } } : tool) })
}
function denied() {
    return new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'The connection is unavailable in this agent’s project' } }) 
}

export const sydAgentConnections = { available, select }
