import { isObject, parseToJsonIfPossible, Permission, tryCatch } from '@activepieces/core-utils'
import { agentAiUtils } from '@activepieces/server-utils'
import { AgentActionKind, AgentActionOutcome, agentToolClassification, AppConnection, AppConnectionStatus, AppConnectionType, FileCompression, FileType, FlowRunStatus, FlowStatus, Project, RunEnvironment } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { appConnectionService, appConnectionsRepo } from '../../../app-connection/app-connection-service/app-connection-service'
import { appConnectionHandler } from '../../../app-connection/app-connection-service/app-connection.handler'
import { fileService } from '../../../file/file.service'
import { filesService } from '../../../file/files-service'
import { flowService } from '../../../flows/flow/flow.service'
import { flowRunService } from '../../../flows/flow-run/flow-run-service'
import { resolvePermissionChecker } from '../../../mcp/mcp-permissions'
import { formatFlowLine } from '../../../mcp/tools/ap-list-flows'
import { runActionInput } from '../../../mcp/tools/ap-run-action'
import { ActionRunOffload, executeCodeActionRun, executePieceActionRun, formatRunSummary } from '../../../mcp/tools/flow-run-utils'
import { mcpUtils } from '../../../mcp/tools/mcp-utils'
import { pieceMetadataService } from '../../../pieces/metadata/piece-metadata-service'
import { tableService } from '../../../tables/table/table.service'
import { StoredConnection, sydApprovalGate } from '../approval-gate'
import { sydConversationFiles } from '../conversation-files'
import { sydConversationService } from '../conversation-service'
import { sydCopilotContext } from '../copilot-context'
import { sydMemoryEditor } from '../memory-editor'
import { sydCopilotPrompt } from '../prompt/copilot-prompt'
import { sydRunOperations } from '../rpc/run-operations'
import { sydChatAgentTools } from './chat-agent-tools'

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() || undefined : undefined
}
function pieceShortName(name: string): string {
    return name.replace('@activepieces/piece-', '')
}
function pieceDisplayLabel(name: string): string {
    return name.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ')
}
function toFlowStatus(value?: string): FlowStatus | undefined {
    return Object.values(FlowStatus).find((status) => status === value)
}
function toFlowRunStatus(value?: string): FlowRunStatus | undefined {
    return Object.values(FlowRunStatus).find((status) => status === value)
}

async function connectionsForProjects({ projects, platformId, pieceName, log }: ProjectQuery & { platformId: string, pieceName?: string }): Promise<AppConnection[]> {
    if (!projects.length) return []
    const pieceFilter = pieceName ? 'AND c."pieceName" = :pieceName' : ''
    const ranked = `SELECT id FROM (SELECT c.id, row_number() OVER (PARTITION BY project_id ORDER BY c.created ASC, c.id ASC) AS position FROM app_connection c CROSS JOIN LATERAL unnest(c."projectIds") AS project_id WHERE c."platformId" = :platformId AND project_id = ANY(:ids::varchar[]) ${pieceFilter}) ranked WHERE position <= 100`
    const encrypted = await appConnectionsRepo().createQueryBuilder('app_connection').where({ platformId, ...(pieceName ? { pieceName } : {}) })
        .andWhere(`app_connection.id IN (${ranked})`, { platformId, ids: projects.map((project) => project.id), pieceName }).orderBy('app_connection.created', 'ASC').addOrderBy('app_connection.id', 'ASC').getMany()
    return Promise.all(encrypted.map((connection) => appConnectionHandler(log).decryptConnection(connection)))
}

function resolveConnectionInfo({ status, type, value }: { status: AppConnectionStatus, type: AppConnectionType, value: unknown }): { status: AppConnectionStatus, grantedScopes: string[] } {
    const oauth = [AppConnectionType.OAUTH2, AppConnectionType.CLOUD_OAUTH2, AppConnectionType.PLATFORM_OAUTH2].includes(type)
    if (!oauth || !isObject(value)) return { status, grantedScopes: [] }
    const grantedScopes = typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : []
    const refreshing = typeof value.refresh_token === 'string' && value.refresh_token.length > 0
    const claimed = Number(value.claimed_at)
    const duration = Number(value.expires_in)
    const expired = !refreshing && Number.isFinite(claimed) && claimed > 0 && Number.isFinite(duration) && duration > 0 && Date.now() > (claimed + duration - 300) * 1000
    return { status: status === AppConnectionStatus.ACTIVE && expired ? AppConnectionStatus.ERROR : status, grantedScopes }
}

async function findConnectionsForPiece({ pieceName, projects, platformId, log }: ProjectQuery & { pieceName: string, platformId: string }): Promise<FindConnectionsResult> {
    const normalized = mcpUtils.normalizePieceName(pieceName) ?? pieceName
    const first = projects[0]
    const metadata = first ? await pieceMetadataService(log).get({ name: normalized, projectId: first.id, platformId }) : null
    if (metadata && metadata.auth == null) return { noAuthRequired: true, piece: normalized }
    const auth = metadata?.auth
    const requiredScopes = auth && 'scope' in auth && Array.isArray(auth.scope) ? auth.scope.filter((scope): scope is string => typeof scope === 'string') : []
    const found = await connectionsForProjects({ projects, platformId, pieceName: normalized, log })
    const connections = projects.flatMap((project) => found.filter((connection) => connection.projectIds.includes(project.id)).slice(0, 100).map((connection) => ({ label: connection.displayName, externalId: connection.externalId, project: sydCopilotPrompt.projectDisplayName(project), projectId: project.id, ...resolveConnectionInfo(connection) })))
    const short = pieceShortName(normalized)
    const displayName = pieceDisplayLabel(short)
    return connections.length ? { pickConnection: true, piece: short, displayName, connections, requiredScopes } : { needsConnection: true, piece: short, displayName, requiredScopes }
}

async function listFlowsAcrossProjects({ projects, status, log }: ProjectQuery & { status?: string }): Promise<TextResult> {
    if (!projects.length) return textResult('No projects available.')
    const selectedStatus = toFlowStatus(status)
    const flows = await flowService(log).list({ projectIds: projects.map((project) => project.id), cursorRequest: null, limit: 200, status: selectedStatus ? [selectedStatus] : undefined })
    return textResult(projects.map((project) => projectSection({ project, lines: flows.data.filter((flow) => flow.projectId === project.id).map(formatFlowLine) })).join('\n\n'))
}

async function listConnectionsAcrossProjects({ projects, platformId, log }: ProjectQuery & { platformId: string }): Promise<TextResult> {
    const connections = await connectionsForProjects({ projects, platformId, log })
    const lines = projects.flatMap((project) => connections.filter((connection) => connection.projectIds.includes(project.id)).slice(0, 100).map((connection) => `- ${connection.displayName} (${pieceShortName(connection.pieceName)}, ${connection.status}) — ${sydCopilotPrompt.projectDisplayName(project)}`))
    return textResult(lines.length ? `Found ${lines.length} connection(s):\n${lines.join('\n')}` : 'No connections found across any project.')
}

async function listResourceForProject({ resource, projectId, status, log }: { resource: 'tables' | 'runs', projectId: string, status?: string, log: FastifyBaseLogger }): Promise<string[]> {
    if (resource === 'tables') {
        const tables = await tableService.list({ projectId, cursor: undefined, limit: 50, name: undefined, externalIds: undefined, folderId: undefined, includeRowCount: true })
        return tables.data.map((table) => `- ${table.name} (${table.id}) — ${table.rowCount ?? 0} records`)
    }
    const filtered = toFlowRunStatus(status)
    const runs = await flowRunService(log).list({ projectId, flowId: undefined, status: filtered ? [filtered] : undefined, environment: RunEnvironment.PRODUCTION, cursor: null, limit: 10 })
    return runs.data.map(formatRunSummary)
}

async function checkWriteRunPermission({ userId, projectId, toolName, log }: { userId: string, projectId: string, toolName: string, log: FastifyBaseLogger }): Promise<string | null> {
    const checker = await resolvePermissionChecker({ userId, projectId, log })
    const denied = checker.check(Permission.WRITE_RUN, toolName)
    return denied ? denied.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : null
}

function buildActionRunOffload({ projectId, platformId, conversationId, pieceName, actionName, log }: { projectId: string, platformId?: string, conversationId?: string, pieceName: string, actionName: string, log: FastifyBaseLogger }): ActionRunOffload | undefined {
    if (!platformId) return undefined
    return { thresholdBytes: 64 * 1024, handle: async ({ payload, byteSize, label, statusNote }) => {
        const bytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
        const saved = await tryCatch(() => fileService(log).save({ projectId, platformId, data: bytes, size: bytes.length, type: FileType.FLOW_STEP_FILE, fileName: `${pieceShortName(pieceName)}-${actionName}.json`, compression: FileCompression.NONE, metadata: { mimetype: 'application/json', ...(conversationId ? { conversationId } : {}) } }))
        return saved.data ? agentAiUtils.buildLargeResultPreview({ payload, byteSize, label, statusNote, fileId: saved.data.id }) : null
    } }
}

async function recordChatAction({ piece, input, projectId, platformId, userId, conversationId, connection, outcome, log }: { piece: { pieceName: string, actionName: string }, input: Record<string, unknown>, projectId: string, platformId?: string, userId: string, conversationId?: string, connection: { externalId?: string, label?: string }, outcome: AgentActionOutcome, log: FastifyBaseLogger }): Promise<void> {
    if (!platformId || agentToolClassification.isReadOnlyActionCall({ actionName: piece.actionName, input })) return
    const metadata = await pieceMetadataService(log).get({ name: piece.pieceName, platformId, projectId })
    sydRunOperations.recordAgentToolUse({ run: { platformId, projectId, userId }, conversationId, outcome, connection, log, action: { kind: AgentActionKind.PIECE, pieceName: piece.pieceName, pieceDisplayName: metadata?.displayName ?? piece.pieceName, actionName: piece.actionName, displayName: metadata?.actions[piece.actionName]?.displayName ?? piece.actionName } })
}

async function runAgentAction({ toolInput, projects, availableProjectIds, conversationId, platformId, userId, requireWritePermission, log }: ActionParams): Promise<unknown> {
    const parsed = runActionInput.parse(toolInput)
    const normalized = mcpUtils.normalizePieceName(parsed.pieceName) ?? parsed.pieceName
    const selected = conversationId ? await sydApprovalGate.getSelectedConnection({ conversationId, pieceName: normalized }) : null
    const projectId = selected?.projectId ?? projects[0]?.id
    if (!projectId || !availableProjectIds.includes(projectId)) return { success: false, error: 'No accessible project is available for this action.' }
    if (requireWritePermission) {
        const denial = await checkWriteRunPermission({ userId, projectId, toolName: 'ap_execute_action', log })
        if (denial) return { success: false, error: denial }
    }
    const result = await executePieceActionRun({ projectId, pieceName: parsed.pieceName, actionName: parsed.actionName, input: parsed.input, connectionExternalId: selected?.externalId, offload: buildActionRunOffload({ projectId, platformId, conversationId, pieceName: normalized, actionName: parsed.actionName, log }), log })
    await recordChatAction({ piece: { pieceName: normalized, actionName: parsed.actionName }, input: parsed.input ?? {}, projectId, platformId, userId, conversationId, connection: { externalId: selected?.externalId, label: selected?.label }, outcome: sydRunOperations.outcomeOfToolResult(result), log })
    const error = isObject(result.structuredContent) && typeof result.structuredContent.errorSummary === 'string' ? result.structuredContent.errorSummary : undefined
    return selected?.label || error ? { ...result, _meta: { ...(selected?.label ? { connectionLabel: selected.label } : {}), ...(error ? { errorSummary: error } : {}), pieceName: normalized } } : result
}

function extractFilesFromOutput(output: unknown): { files: RawProducedFile[], rest: unknown } {
    if (!isObject(output) || !Array.isArray(output.files)) return { files: [], rest: output }
    const files = output.files.filter((file): file is RawProducedFile => isObject(file) && typeof file.name === 'string' && typeof file.mimeType === 'string' && typeof file.base64 === 'string')
    const { files: _files, ...rest } = output
    return { files, rest }
}

function decodeBase64(value: string): Buffer | undefined {
    const bytes = Buffer.from(value.replace(/^data:[^;]+;base64,/, ''), 'base64')
    return bytes.length ? bytes : undefined
}

function buildCodeResultText({ rest, producedFiles }: { rest: unknown, producedFiles: ProducedFile[] }): string {
    const fileNote = producedFiles.length ? `Returned ${producedFiles.length} file(s) to the user: ${producedFiles.map((file) => file.fileName).join(', ')}.` : ''
    if (rest == null || (isObject(rest) && !Object.keys(rest).length)) return fileNote ? `✅ Code ran. ${fileNote}` : '✅ Code ran (no output returned).'
    const serialized = typeof rest === 'string' ? rest : JSON.stringify(rest)
    return ['✅ Code ran.', serialized.length > 20_000 ? `${serialized.slice(0, 20_000)}… (truncated)` : serialized, fileNote].filter(Boolean).join('\n\n')
}

async function persistProducedFiles({ output, projectId, platformId, conversationId, log }: { output: unknown, projectId: string, platformId: string, conversationId?: string, log: FastifyBaseLogger }): Promise<RunCodeToolResult> {
    const extracted = extractFilesFromOutput(output)
    const producedFiles: ProducedFile[] = []
    for (const file of extracted.files.slice(0, 10)) {
        const bytes = decodeBase64(file.base64)
        if (!bytes || bytes.length > 25 * 1024 * 1024) continue
        const saved = await fileService(log).save({ projectId, platformId, data: bytes, size: bytes.length, type: FileType.FLOW_STEP_FILE, compression: FileCompression.NONE, fileName: file.name, metadata: { mimetype: file.mimeType, ...(conversationId ? { conversationId } : {}) } })
        producedFiles.push({ fileId: saved.id, url: await filesService.constructReadUrl({ platformId, fileId: saved.id, fileType: saved.type }), mediaType: file.mimeType, fileName: file.name, byteSize: bytes.length })
    }
    return { text: buildCodeResultText({ rest: extracted.rest, producedFiles }), producedFiles }
}

async function runAgentCode({ toolInput, projects, platformId, userId, conversationId, log }: CrossProjectParams & { projects: Project[] }): Promise<RunCodeToolResult> {
    const code = nonEmpty(toolInput.code)
    if (!code) return { text: '❌ `code` is required and must be a non-empty string.', producedFiles: [] }
    const conversation = conversationId ? await sydConversationService(log).getConversationOrThrow({ id: conversationId, platformId, userId }) : null
    const projectId = projects.find((project) => project.id === conversation?.projectId)?.id ?? projects[0]?.id
    if (!projectId) return { text: '❌ No projects available. Create a project first.', producedFiles: [] }
    const denied = await checkWriteRunPermission({ userId, projectId, toolName: 'ap_run_code', log })
    if (denied) return { text: `❌ ${denied}`, producedFiles: [] }
    const base = isObject(toolInput.input) ? toolInput.input : {}
    const ids = Array.isArray(toolInput.inputFileIds) ? toolInput.inputFileIds.filter((id): id is string => typeof id === 'string') : []
    const inputFiles: { name: string, mimeType: string, base64: string }[] = []
    for (const id of ids) {
        const loaded = await tryCatch(() => conversationId ? sydConversationFiles.readConversationFile({ platformId, conversationId, accessibleProjectIds: projects.map((project) => project.id), fileId: id, log }) : fileService(log).getDataOrThrow({ projectId, fileId: id, type: FileType.FLOW_STEP_FILE }))
        if (!loaded.data) return { text: `❌ Couldn't load attachment ${id}.`, producedFiles: [] }
        inputFiles.push({ name: loaded.data.fileName ?? id, mimeType: typeof loaded.data.metadata?.mimetype === 'string' ? loaded.data.metadata.mimetype : 'application/octet-stream', base64: loaded.data.data.toString('base64') })
    }
    const parsed = inputFiles.filter((file) => file.mimeType.includes('json') || file.name.toLowerCase().endsWith('.json')).map((file) => parseToJsonIfPossible(Buffer.from(file.base64, 'base64').toString('utf8'))).filter((value) => isObject(value) || Array.isArray(value))
    const input = { ...base, ...(inputFiles.length ? { files: inputFiles } : {}), ...(parsed.length && base.data === undefined ? { data: parsed.length === 1 ? parsed[0] : parsed } : {}) }
    const result = await executeCodeActionRun({ projectId, code, packageJson: nonEmpty(toolInput.packageJson), input, log })
    if (result.status !== 'succeeded') return { text: `❌ ${result.errorMessage ?? (result.status === 'timeout' ? 'Code is still running after 120s.' : 'Code execution failed.')}`, producedFiles: [] }
    return persistProducedFiles({ output: result.output, projectId, platformId, conversationId, log })
}

async function executeCrossProjectTool(params: CrossProjectParams): Promise<unknown> {
    const { toolName, toolInput, platformId, userId, conversationId, log } = params
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    const common = { toolInput, projects, platformId, userId, conversationId, log }
    if (toolName === 'ap_remember') {
        const memory = nonEmpty(toolInput.memory)
        if (!memory) return { success: false, error: 'Empty memory.' }
        await sydMemoryEditor.applyInstruction({ platformId, userId, instruction: memory, log })
        return { remembered: true }
    }
    if (toolName === 'ap_discover_action_auth') {
        const pieceName = runActionInput.pick({ pieceName: true }).parse(toolInput).pieceName
        const normalized = mcpUtils.normalizePieceName(pieceName) ?? pieceName
        const selected = conversationId ? await sydApprovalGate.getSelectedConnection({ conversationId, pieceName: normalized }) : null
        if (selected) return { alreadyConnected: true, piece: normalized, auth: selected.externalId, connectionLabel: selected.label, note: 'Reuse the selected account; do not show another picker.' }
        const discovery = await findConnectionsForPiece({ projects, platformId, pieceName, log })
        if (conversationId && 'pickConnection' in discovery) {
            await sydApprovalGate.storeAvailableConnections({ conversationId, pieceName: normalized, connections: discovery.connections })
            return { pickConnection: true, piece: discovery.piece, displayName: discovery.displayName, connectionCount: discovery.connections.length, requiredScopes: discovery.requiredScopes }
        }
        return discovery
    }
    if (toolName === 'ap_revalidate_connection') {
        const externalId = runActionInput.pick({ connectionExternalId: true }).required().parse(toolInput).connectionExternalId
        const conversation = conversationId ? await sydConversationService(log).getConversationOrThrow({ id: conversationId, platformId, userId }) : null
        const projectId = projects.find((project) => project.id === conversation?.projectId)?.id
        if (!projectId) return { connectionExternalId: externalId, notFound: true, note: 'No project is selected for this conversation.' }
        const checker = await resolvePermissionChecker({ userId, projectId, log })
        const denial = checker.check(Permission.WRITE_APP_CONNECTION, toolName)
        if (denial) return denial
        const connection = await appConnectionService(log).getOneWithoutValue({ platformId, projectId, externalId })
        if (!connection) return { connectionExternalId: externalId, notFound: true }
        const checked = await appConnectionService(log).revalidate({ id: connection.id, platformId, projectId })
        return { connectionExternalId: externalId, status: checked.status, working: checked.status === AppConnectionStatus.ACTIVE, note: checked.status === AppConnectionStatus.ACTIVE ? 'This connection is valid — safe to build on.' : 'The credentials failed; show the picker to reconnect before retrying.' }
    }
    if (AGENT_TOOLS.has(toolName)) return sydChatAgentTools.execute({ ...common, toolName })
    if (toolName === 'ap_run_code') return runAgentCode({ ...params, projects })
    if (toolName === 'ap_execute_action' || toolName === 'ap_explore_data') {
        if (toolName === 'ap_explore_data') {
            const parsed = runActionInput.parse(toolInput)
            if (!agentToolClassification.isReadOnlyActionCall({ actionName: parsed.actionName, input: parsed.input })) return agentToolClassification.readOnlyRejection(parsed.actionName)
        }
        return runAgentAction({ ...common, availableProjectIds: projects.map((project) => project.id), requireWritePermission: toolName === 'ap_execute_action' })
    }
    if (toolName === 'ap_list_across_projects') {
        const status = nonEmpty(toolInput.status)
        if (toolInput.resource === 'flows') return listFlowsAcrossProjects({ projects, status, log })
        if (toolInput.resource === 'connections') return listConnectionsAcrossProjects({ projects, platformId, log })
        const resource = toolInput.resource === 'tables' ? 'tables' : 'runs'
        const sections = await Promise.all(projects.map(async (project) => projectSection({ project, lines: await listResourceForProject({ resource, projectId: project.id, status, log }) })))
        return textResult(sections.join('\n\n'))
    }
    return { error: `Unknown cross-project tool: ${toolName}` }
}

function textResult(text: string): TextResult {
    return { content: [{ type: 'text', text }] }
}
function projectSection({ project, lines }: { project: Project, lines: string[] }): string {
    return `**${sydCopilotPrompt.projectDisplayName(project)}** (${project.id}):\n${lines.length ? lines.join('\n') : 'None found.'}`
}

const AGENT_TOOLS = new Set(['ap_list_agents', 'ap_create_agent', 'ap_update_agent', 'ap_add_agent_tool', 'ap_remove_agent_tool'])

export const sydCopilotActions: SydCopilotActions = { ...sydChatAgentTools, nonEmpty, pieceShortName, pieceDisplayLabel, toFlowStatus, toFlowRunStatus, connectionsForProjects, resolveConnectionInfo, findConnectionsForPiece, listFlowsAcrossProjects, listConnectionsAcrossProjects, listResourceForProject, checkWriteRunPermission, buildActionRunOffload, recordChatAction, runAgentAction, extractFilesFromOutput, decodeBase64, buildCodeResultText, persistProducedFiles, runAgentCode, executeCrossProjectTool }

type ProjectQuery = { projects: Project[], log: FastifyBaseLogger }
type TextResult = { content: { type: string, text: string }[] }
type FindConnectionsResult = { noAuthRequired: true, piece: string } | { needsConnection: true, piece: string, displayName: string, requiredScopes: string[] } | { pickConnection: true, piece: string, displayName: string, connections: ConnectionWithScopes[], requiredScopes: string[] }
type CrossProjectParams = { toolName: string, toolInput: Record<string, unknown>, platformId: string, userId: string, conversationId?: string, log: FastifyBaseLogger }
type ActionParams = Omit<CrossProjectParams, 'toolName' | 'platformId'> & { projects: Project[], availableProjectIds: string[], platformId?: string, requireWritePermission?: boolean }
type RawProducedFile = { name: string, mimeType: string, base64: string }
type ProducedFile = { fileId: string, url: string, mediaType: string, fileName: string, byteSize: number }
type RunCodeToolResult = { text: string, producedFiles: ProducedFile[] }

export type ConnectionWithScopes = StoredConnection

type SydCopilotActions = typeof sydChatAgentTools & {
    nonEmpty: typeof nonEmpty
    pieceShortName: typeof pieceShortName
    pieceDisplayLabel: typeof pieceDisplayLabel
    toFlowStatus: typeof toFlowStatus
    toFlowRunStatus: typeof toFlowRunStatus
    connectionsForProjects: typeof connectionsForProjects
    resolveConnectionInfo: typeof resolveConnectionInfo
    findConnectionsForPiece: typeof findConnectionsForPiece
    listFlowsAcrossProjects: typeof listFlowsAcrossProjects
    listConnectionsAcrossProjects: typeof listConnectionsAcrossProjects
    listResourceForProject: typeof listResourceForProject
    checkWriteRunPermission: typeof checkWriteRunPermission
    buildActionRunOffload: typeof buildActionRunOffload
    recordChatAction: typeof recordChatAction
    runAgentAction: typeof runAgentAction
    extractFilesFromOutput: typeof extractFilesFromOutput
    decodeBase64: typeof decodeBase64
    buildCodeResultText: typeof buildCodeResultText
    persistProducedFiles: typeof persistProducedFiles
    runAgentCode: typeof runAgentCode
    executeCrossProjectTool: typeof executeCrossProjectTool
}
