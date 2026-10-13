import { ActivepiecesError, connectionTemplate, ErrorCode, Permission } from '@activepieces/core-utils'
import { Agent, AgentConversationStatus, AgentMoveLoss, AgentMoveLossKind, AgentMovePreview, AgentRunSource, AgentToolType, FlowVersionState, KnowledgeBaseSourceType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { appConnectionService } from '../../app-connection/app-connection-service/app-connection-service'
import { transaction } from '../../core/db/transaction'
import { flowService } from '../../flows/flow/flow.service'
import { publishedFlowVersionsUsingAgent } from '../../flows/flow-version/flow-version.service'
import { knowledgeBaseService } from '../../knowledge-base/knowledge-base.service'
import { resolvePermissionChecker } from '../../mcp/mcp-permissions'
import { sydAgentRuntime } from './agent-runtime'
import { sydCopilotContext } from './copilot-context'
import { SydAgentConversationEntity } from './models/agent-conversation.entity'
import { SydChatManagedAgentEntity } from './models/chat-managed-agent.entity'
import { sydChatAgentAdministration, sydChatAgentAdministrationSupport } from './tools/chat-agent-administration'

async function preview(params: TransferParams): Promise<AgentMovePreview> {
    const { id, projectId, userId, targetProjectId, platformId, log } = params
    const service = sydChatAgentAdministration(log)
    const agent = await service.getOneOrThrow({ id, projectId, userId })
    await sydChatAgentAdministrationSupport.assertMayDestroy({ agent, projectId, userId, log })
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    if (!projects.some((project) => project.id === targetProjectId)) throw refused('The destination project is unavailable')
    const checker = await resolvePermissionChecker({ userId, projectId: targetProjectId, log })
    const members = await sydChatAgentAdministrationSupport.listUsersWithProjectAccess({ projectId: targetProjectId, log })
    return { blockedByPublishedFlows: await service.publishedFlowsUsing({ agent, projectId, userId }), mayCreateAgentsThere: !checker.check(Permission.WRITE_AGENT, 'move-agent'), toolsThatStopWorking: await losses({ agent, targetProjectId, platformId, log }), membersLosingAccess: agent.sharedWithUserIds.filter((member) => !members.includes(member)).length }
}

async function move(params: TransferParams): Promise<Agent> {
    const { id, projectId, userId, targetProjectId, platformId, log } = params
    if (projectId === targetProjectId) return sydChatAgentAdministration(log).getOneOrThrow({ id, projectId, userId })
    const report = await preview(params)
    if (!report.mayCreateAgentsThere || report.blockedByPublishedFlows.total) throw refused('Published missions must stop using this agent before it can move')
    const members = await sydChatAgentAdministrationSupport.listUsersWithProjectAccess({ projectId: targetProjectId, log })
    await transaction(async (manager) => {
        const agent = await sydChatAgentAdministrationSupport.lockedAgentInProjectOrThrow({ entityManager: manager, id, projectId })
        if (await sydAgentRuntime.repo().existsBy({ platformId, projectId, agentId: id, status: AgentConversationStatus.STREAMING })) throw refused('Wait for this agent’s current run to finish before moving it')
        const repo = manager.getRepository(SydChatManagedAgentEntity)
        if (await repo.existsBy({ projectId: targetProjectId, externalId: agent.externalId })) throw refused('An agent with this external identifier already exists in the destination')
        const consuming = publishedFlowVersionsUsingAgent({ projectId, agentExternalId: agent.externalId, alias: 'using_agent' })
        const moved = await repo.createQueryBuilder().update().set({ projectId: targetProjectId, folderId: null, sharedWithUserIds: agent.sharedWithUserIds.filter((member) => members.includes(member)) }).where({ id, projectId }).andWhere(`NOT EXISTS (${consuming.getQuery()})`).setParameters(consuming.getParameters()).returning('id').execute()
        if (!Array.isArray(moved.raw) || !moved.raw.length) throw refused('A published mission now uses this agent')
        await manager.getRepository(SydAgentConversationEntity).update({ platformId, projectId, agentId: id, source: In([AgentRunSource.AGENT, AgentRunSource.AGENT_BUILDER]) }, { projectId: targetProjectId })
    })
    return sydChatAgentAdministration(log).getOneOrThrow({ id, projectId: targetProjectId, userId })
}

async function losses({ agent, targetProjectId, platformId, log }: { agent: Agent, targetProjectId: string, platformId: string, log: FastifyBaseLogger }): Promise<AgentMoveLoss[]> {
    const tools = [...agent.draft.tools, ...agent.published?.tools ?? []]
    const checks = await Promise.all(tools.map(async (tool): Promise<AgentMoveLoss | null> => {
        if (tool.type === AgentToolType.PIECE) {
            const externalId = connectionTemplate.unwrapExternalId(tool.pieceMetadata.predefinedInput?.auth)
            if (!externalId) return null
            const connection = await appConnectionService(log).getOneWithoutValue({ platformId, projectId: targetProjectId, externalId })
            return connection?.pieceName === tool.pieceMetadata.pieceName ? null : { kind: AgentMoveLossKind.CONNECTION, label: tool.toolName }
        }
        if (tool.type === AgentToolType.FLOW) {
            const flows = await flowService(log).list({ projectIds: [targetProjectId], externalIds: [tool.externalFlowId], cursorRequest: null, includeTriggerSource: false, versionState: FlowVersionState.LOCKED })
            return flows.data.length ? null : { kind: AgentMoveLossKind.FLOW, label: tool.flowDisplayName ?? tool.toolName }
        }
        if (tool.type === AgentToolType.KNOWLEDGE_BASE) {
            const available = tool.sourceType === KnowledgeBaseSourceType.TABLE
                ? await sydAgentRuntime.repo().manager.getRepository('table').existsBy({ id: tool.sourceId, projectId: targetProjectId })
                : (await knowledgeBaseService(log).getFilesByIds({ projectId: targetProjectId, ids: [tool.sourceId] })).length > 0
            return available ? null : { kind: AgentMoveLossKind.KNOWLEDGE, label: tool.sourceName }
        }
        return null
    }))
    const entries = checks.filter((value): value is AgentMoveLoss => value !== null)
    return entries.filter((entry, index) => entries.findIndex((other) => other.kind === entry.kind && other.label === entry.label) === index)
}
function refused(message: string) {
    return new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message } }) 
}

export const sydAgentTransfer = { preview, move }
type TransferParams = { id: string, projectId: string, targetProjectId: string, platformId: string, userId: string, log: FastifyBaseLogger }
