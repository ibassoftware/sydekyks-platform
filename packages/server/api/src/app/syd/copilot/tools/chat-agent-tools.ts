import { Permission, tryCatch } from '@activepieces/core-utils'
import { Agent, AgentIcon, AgentTool, AgentToolType, ApplicationEventName, ColorName, DEFAULT_AGENT_MAX_STEPS, mcpToolNameUtils, Project } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { appConnectionService } from '../../../app-connection/app-connection-service/app-connection-service'
import { applicationEvents } from '../../../helper/application-events'
import { domainHelper } from '../../../helper/domain-helper'
import { resolvePermissionChecker } from '../../../mcp/mcp-permissions'
import { mcpUtils } from '../../../mcp/tools/mcp-utils'
import { pieceMetadataService } from '../../../pieces/metadata/piece-metadata-service'
import { sydConversationService } from '../conversation-service'
import { sydCopilotContext } from '../copilot-context'
import { sydRunContext } from '../prompt/run-context'
import { sydChatAgentAdministration, sydChatAgentAdministrationSupport } from './chat-agent-administration'

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() || undefined : undefined
}
function briefOnly(value: unknown): string | undefined {
    const text = nonEmpty(value); return text ? nonEmpty(sydRunContext.stripRunNotes(text)) : undefined
}
function toolNamesFrom(toolInput: Record<string, unknown>): string[] {
    return Array.isArray(toolInput.actionNames) ? toolInput.actionNames.flatMap((name) => nonEmpty(name) ?? []) : []
}
function pieceActionOf(tool: AgentTool): { pieceName: string, actionName: string } | undefined {
    return tool.type === AgentToolType.PIECE ? { pieceName: tool.pieceMetadata.pieceName, actionName: tool.pieceMetadata.actionName } : undefined
}

async function afterDraftChange({ agent, publish, projectId, platformId, userId, log }: ChangedParams): Promise<unknown> {
    const published = publish ? await tryCatch(() => sydChatAgentAdministration(log).publish({ id: agent.id, projectId, platformId, userId })) : null
    const landed = published?.data
    applicationEvents(log).sendUserEvent({ platformId, projectId, userId }, { action: landed ? ApplicationEventName.AGENT_PUBLISHED : ApplicationEventName.AGENT_UPDATED, data: { agent: { id: agent.id, displayName: agent.displayName, ...(landed ? sydChatAgentAdministrationSupport.describePublished({ published: agent.draft }) : {}) } } })
    return { agentId: agent.id, flowAgentId: agent.externalId, displayName: agent.displayName, published: Boolean(landed), url: await domainHelper.getPublicUrl({ path: `/projects/${projectId}/agents/${agent.id}` }), note: landed ? `"${agent.displayName}" is live: new runs use this version.` : publish ? 'Publishing failed; the draft is saved, but the change is not live. Review it at the agent URL.' : agent.published ? 'Saved to the draft. The published version keeps running until this change is published.' : 'Saved to the draft. Nothing runs this agent until it is published.' }
}

async function createAgentFromChat({ toolInput, platformId, projectId, userId, log }: ToolParams): Promise<unknown> {
    const displayName = nonEmpty(toolInput.displayName)
    const instructions = briefOnly(toolInput.instructions)
    if (!displayName || !instructions) return { error: 'An agent needs a name and instructions.' }
    const agent = await sydChatAgentAdministration(log).create({ platformId, projectId, ownerId: userId, request: { projectId, displayName, description: nonEmpty(toolInput.description) ?? null, icon: AgentIcon.SPARKLES, color: ColorName.PURPLE, draft: { instructions, maxSteps: DEFAULT_AGENT_MAX_STEPS, tools: [], structuredOutput: [] } } })
    return afterDraftChange({ agent, publish: false, platformId, projectId, userId, log })
}

async function updateAgentFromChat({ toolInput, agent, platformId, projectId, userId, log }: EditParams): Promise<unknown> {
    const displayName = nonEmpty(toolInput.displayName)
    const description = nonEmpty(toolInput.description)
    const instructions = briefOnly(toolInput.instructions)
    if (!displayName && !description && !instructions && toolInput.publish !== true) return { error: 'Nothing to change. Supply a non-empty name, description or complete instruction brief.' }
    const updated = await sydChatAgentAdministration(log).update({ id: agent.id, platformId, projectId, userId, request: { ...(displayName ? { displayName } : {}), ...(description ? { description } : {}), ...(instructions ? { draft: { ...agent.draft, instructions } } : {}) } })
    return afterDraftChange({ agent: updated, publish: toolInput.publish === true, platformId, projectId, userId, log })
}

async function resolveConnectionToPin({ piece, pieceName, projectId, platformId, log }: { piece: { displayName: string }, pieceName: string, projectId: string, platformId: string, log: FastifyBaseLogger }): Promise<{ externalId?: string } | { error: string }> {
    const list = await appConnectionService(log).list({ platformId, projectId, pieceName, cursorRequest: null, displayName: undefined, status: undefined, scope: undefined, externalIds: undefined, limit: 10 })
    if (list.data.length === 1) return { externalId: list.data[0].externalId }
    return { error: list.data.length ? `${piece.displayName} has multiple accounts. Choose a connectionExternalId from ap_list_connections.` : `${piece.displayName} needs an account. Connect one and retry.` }
}

async function addAgentToolFromChat({ toolInput, agent, platformId, projectId, userId, log }: EditParams): Promise<unknown> {
    const requestedPiece = nonEmpty(toolInput.pieceName)
    const actions = toolNamesFrom(toolInput)
    if (!requestedPiece || !actions.length) return { error: 'Adding tools needs the piece name and at least one action name.' }
    const pieceName = mcpUtils.normalizePieceName(requestedPiece) ?? requestedPiece
    const piece = await pieceMetadataService(log).get({ name: pieceName, projectId, platformId })
    const missing = actions.filter((action) => !piece?.actions[action])
    if (!piece || missing.length) return { error: `${pieceName} has no action called ${missing.join(' or ')}. Research the piece before adding it.` }
    const requestedConnection = nonEmpty(toolInput.connectionExternalId)
    if (requestedConnection) {
        const connection = await appConnectionService(log).getOneWithoutValue({ platformId, projectId, externalId: requestedConnection })
        if (!connection || mcpUtils.normalizePieceName(connection.pieceName) !== pieceName) return { error: 'Choose a connection for this app in this project.' }
    }
    const binding = requestedConnection || !piece.auth ? { externalId: requestedConnection } : await resolveConnectionToPin({ piece, pieceName, projectId, platformId, log })
    if ('error' in binding) return binding
    const additions: AgentTool[] = actions.map((actionName) => ({ type: AgentToolType.PIECE, toolName: mcpToolNameUtils.createPieceToolName(pieceName, actionName), pieceMetadata: { pieceName, pieceVersion: piece.version, actionName, ...(binding.externalId ? { predefinedInput: { auth: binding.externalId, fields: {} } } : {}) } }))
    const updated = await sydChatAgentAdministration(log).editDraftTools({ id: agent.id, projectId, userId, edit: (tools) => appendTools({ tools, additions, pieceName, actions }) })
    return updated ? afterDraftChange({ agent: updated, publish: toolInput.publish === true, platformId, projectId, userId, log }) : { error: `${agent.displayName} already has one of those tools.` }
}

function appendTools({ tools, additions, pieceName, actions }: { tools: AgentTool[], additions: AgentTool[], pieceName: string, actions: string[] }): AgentTool[] | null {
    return tools.some((tool) => {
        const action = pieceActionOf(tool); return action?.pieceName === pieceName && actions.includes(action.actionName)
    }) ? null : [...tools, ...additions]
}

async function removeAgentToolFromChat({ toolInput, agent, platformId, projectId, userId, log }: EditParams): Promise<unknown> {
    const actions = toolNamesFrom(toolInput)
    if (!actions.length) return { error: 'Removing tools needs at least one action name.' }
    const requested = nonEmpty(toolInput.pieceName)
    const scope = requested ? mcpUtils.normalizePieceName(requested) ?? requested : undefined
    const targets = agent.draft.tools.flatMap((tool) => pieceActionOf(tool) ?? []).filter((action) => actions.includes(action.actionName) && (!scope || action.pieceName === scope))
    for (const action of actions) {
        const pieces = new Set(targets.filter((target) => target.actionName === action).map((target) => target.pieceName))
        if (pieces.size !== 1) return { error: pieces.size ? `Specify pieceName: ${action} is present on multiple apps.` : `No tool for ${action} is present in this scope.` }
    }
    const keys = new Set(targets.map((target) => `${target.pieceName}:${target.actionName}`))
    const updated = await sydChatAgentAdministration(log).editDraftTools({ id: agent.id, projectId, userId, edit: (tools) => removeTools({ tools, keys }) })
    return updated ? afterDraftChange({ agent: updated, publish: toolInput.publish === true, platformId, projectId, userId, log }) : { error: `${agent.displayName} has none of those tools.` }
}

function removeTools({ tools, keys }: { tools: AgentTool[], keys: Set<string> }): AgentTool[] | null {
    const retained = tools.filter((tool) => {
        const action = pieceActionOf(tool); return !action || !keys.has(`${action.pieceName}:${action.actionName}`)
    })
    return retained.length === tools.length ? null : retained
}

async function execute({ toolName, toolInput, projects, platformId, userId, conversationId, log }: { toolName: string, toolInput: Record<string, unknown>, projects: Project[], platformId: string, userId: string, conversationId?: string, log: FastifyBaseLogger }): Promise<unknown> {
    if (!await sydCopilotContext.agentsSurfaceAvailable({ platformId, log })) return { error: 'Agents are not available here.' }
    const conversation = conversationId ? await sydConversationService(log).getConversationOrThrow({ id: conversationId, platformId, userId }) : null
    const projectId = projects.find((project) => project.id === conversation?.projectId)?.id
    if (!projectId) return { error: 'Select the project the agent belongs to first.' }
    const permission = await resolvePermissionChecker({ userId, projectId, log })
    const denial = permission.check(toolName === 'ap_list_agents' ? Permission.READ_AGENT : Permission.WRITE_AGENT, toolName)
    if (denial) return denial
    const service = sydChatAgentAdministration(log)
    const params = { toolInput, projectId, platformId, userId, log }
    if (toolName === 'ap_list_agents') return (await service.list({ projectId, platformId, userId, limit: 50 })).data.map(({ id, externalId, displayName, description, isPublished, toolCount }) => ({ agentId: id, flowAgentId: externalId, displayName, description, published: isPublished, toolCount }))
    if (toolName === 'ap_create_agent') return createAgentFromChat(params)
    const id = nonEmpty(toolInput.agentId)
    if (!id) return { error: 'Call ap_list_agents and provide the agentId to change.' }
    const resolved = await tryCatch(() => service.getOneOrThrow({ id, projectId, userId }))
    if (!resolved.data) return { error: 'No accessible agent with that id exists in this project.' }
    const editing = { ...params, agent: resolved.data }
    return toolName === 'ap_update_agent' ? updateAgentFromChat(editing) : toolName === 'ap_remove_agent_tool' ? removeAgentToolFromChat(editing) : addAgentToolFromChat(editing)
}

export const sydChatAgentTools = { briefOnly, toolNamesFrom, pieceActionOf, afterDraftChange, createAgentFromChat, updateAgentFromChat, resolveConnectionToPin, addAgentToolFromChat, appendTools, removeAgentToolFromChat, removeTools, execute }

type ToolParams = { toolInput: Record<string, unknown>, projectId: string, platformId: string, userId: string, log: FastifyBaseLogger }
type EditParams = ToolParams & { agent: Agent }
type ChangedParams = Omit<ToolParams, 'toolInput'> & { agent: Agent, publish: boolean }
