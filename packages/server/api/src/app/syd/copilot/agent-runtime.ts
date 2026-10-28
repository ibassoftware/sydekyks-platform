import { createHash } from 'node:crypto'
import { ActivepiecesError, apId, ErrorCode, Permission, sanitizeObjectForPostgresql, tryCatch } from '@activepieces/core-utils'
import { AgentConfig, AgentConversation, AgentConversationStatus, AgentRunSource, AgentTool, AgentToolType, FlowVersionState, LATEST_JOB_DATA_SCHEMA_VERSION, ResolvedAgentFlowTool, TASK_COMPLETION_TOOL_NAME, WorkerJobType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { transaction } from '../../core/db/transaction'
import { databaseConnection } from '../../database/database-connection'
import { distributedStore } from '../../database/redis-connections'
import { flowService } from '../../flows/flow/flow.service'
import { validateHostedAiFileIdsForActor } from '../../hosting/hosting-ai-files'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { assertHostedChatContext, hostedCopilotPayer } from '../../hosting/hosting-copilot'
import { HostingDispatchEntity } from '../../hosting/hosting-dispatch-entity'
import { HostingJobOrigin } from '../../hosting/hosting-execution'
import { resolvePermissionChecker } from '../../mcp/mcp-permissions'
import { extractMcpTriggerInput } from '../../mcp/mcp-server-builder'
import { mcpToolInput } from '../../mcp/mcp-tool-input'
import { assertCreditsAndAppSumoNotExceeded } from '../../platform/billing-provider'
import { jobQueue, JobType } from '../../workers/job-queue/job-queue'
import { sydApprovalGate } from './approval-gate'
import { conversationTitle } from './conversation-title'
import { ActorScope, sydCopilotContext } from './copilot-context'
import { SydAgentConversationEntity } from './models/agent-conversation.entity'
import { nativeFilesForTurn } from './native-features'
import { sydChatAgentAdministration } from './tools/chat-agent-administration'

function repo() {
    return databaseConnection().getRepository(SydAgentConversationEntity)
}

async function get({ id, platformId, userId, log }: ActorScope & { id: string, log: FastifyBaseLogger }): Promise<AgentConversation> {
    const conversation = await repo().findOneBy({ id, platformId, userId })
    if (!conversation || !conversation.projectId || conversation.source === AgentRunSource.CHAT || conversation.source === AgentRunSource.FLOW_STEP || (!conversation.agentId && conversation.source !== AgentRunSource.AGENT_BUILDER)) throw unavailable(id)
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    if (!projects.some((project) => project.id === conversation.projectId)) throw unavailable(id)
    const checker = await resolvePermissionChecker({ userId, projectId: conversation.projectId, log })
    if (checker.check(Permission.READ_AGENT, 'agent-chat')) throw unavailable(id)
    if (conversation.agentId) await sydChatAgentAdministration(log).getOneOrThrow({ id: conversation.agentId, projectId: conversation.projectId, userId })
    if (conversation.status === AgentConversationStatus.STREAMING && Date.now() - Date.parse(conversation.updated) > 90000) {
        const scope = { id, platformId, userId, projectId: conversation.projectId, updated: conversation.updated, status: AgentConversationStatus.STREAMING }
        const recovered = await repo().update(scope, { status: AgentConversationStatus.IDLE })
        if (recovered.affected) return { ...conversation, status: AgentConversationStatus.IDLE }
    }
    return conversation
}

async function create({ platformId, userId, agentId, builder, projectId, log }: ActorScope & { agentId?: string, builder: boolean, projectId?: string, log: FastifyBaseLogger }): Promise<AgentConversation> {
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    const agent = agentId ? await repoAgentInProjects({ agentId, projectIds: projects.map((project) => project.id), userId, log }) : null
    const selectedProjectId = agent?.projectId ?? projectId
    if ((!agent && !builder) || !selectedProjectId || !projects.some((project) => project.id === selectedProjectId)) throw unavailable(agentId ?? projectId ?? 'project')
    const checker = await resolvePermissionChecker({ userId, projectId: selectedProjectId, log })
    if (checker.check(builder ? Permission.WRITE_AGENT : Permission.READ_AGENT, 'configure-agent')) throw unavailable(selectedProjectId)
    return repo().save({ id: apId(), platformId, userId, projectId: selectedProjectId, agentId: agent?.id ?? null, source: builder ? AgentRunSource.AGENT_BUILDER : AgentRunSource.AGENT, flowRunId: null, title: null, modelName: null, status: AgentConversationStatus.IDLE, activeRunId: null, messages: [], uiMessages: [], aiCredits: null, summary: null, summarizedUpToIndex: null })
}

async function repoAgentInProjects({ agentId, projectIds, userId, log }: { agentId: string, projectIds: string[], userId: string, log: FastifyBaseLogger }) {
    for (const projectId of projectIds) {
        const found = await tryCatch(() => sydChatAgentAdministration(log).getOneOrThrow({ id: agentId, projectId, userId }))
        if (found.data) {
            const checker = await resolvePermissionChecker({ userId, projectId, log })
            if (checker.check(Permission.READ_AGENT, 'agent-chat')) throw unavailable(agentId)
            return found.data
        }
        if (!(found.error instanceof ActivepiecesError) || found.error.error.code !== ErrorCode.ENTITY_NOT_FOUND) throw found.error
    }
    throw unavailable(agentId)
}

async function resolveFlowTools({ tools, projectId, log }: { tools: AgentTool[], projectId: string, log: FastifyBaseLogger }): Promise<ResolvedAgentFlowTool[]> {
    return Promise.all(tools.filter((tool) => tool.type === AgentToolType.FLOW).map(async (tool) => {
        const query = { projectIds: [projectId], externalIds: [tool.externalFlowId], cursorRequest: null, includeTriggerSource: false }
        const [published, drafts] = await Promise.all([flowService(log).list({ ...query, versionState: FlowVersionState.LOCKED }), flowService(log).list({ ...query, versionState: FlowVersionState.DRAFT })])
        const flow = [...published.data, ...drafts.data].find((candidate) => candidate.externalId === tool.externalFlowId)
        if (!flow) throw unavailable(tool.externalFlowId)
        const trigger = extractMcpTriggerInput(flow)
        return { toolName: tool.toolName, flowId: flow.id, flowVersionId: flow.version.id, description: trigger.toolDescription || `Run ${flow.version.displayName}`, inputSchema: z.toJSONSchema(z.object(mcpToolInput.modelInputShape({ properties: trigger.mcpInputs }))), returnsResponse: trigger.returnsResponse }
    }))
}

function validateTools(config: AgentConfig): void {
    const names = config.tools.map((tool) => tool.toolName)
    if (new Set(names).size !== names.length || names.some((name) => name.startsWith('ap_') || name === TASK_COMPLETION_TOOL_NAME)) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'Agent tools need unique names that are not reserved for built-in tools' } })
}

async function start({ conversation, config, content, files, nativeFileIds: addedNativeFileIds, nativeWebSearch, modelName, waitpointId, tokenVersion, hostedOrigin, log }: { conversation: AgentConversation, config: AgentConfig, content: string, nativeFileIds?: string[], nativeWebSearch?: boolean, files?: Array<{ name: string, mimeType: string, data: string }>, modelName?: string | null, waitpointId?: string, tokenVersion?: string | null, hostedOrigin?: HostingJobOrigin, log: FastifyBaseLogger }): Promise<{ conversationId: string, runId: string }> {
    if (!conversation.projectId) throw unavailable(conversation.id)
    const builder = conversation.source === AgentRunSource.AGENT_BUILDER
    const jobConfig = builder ? { ...config, provider: null, providerConfigId: null, tools: [], structuredOutput: [] } : config
    validateTools(jobConfig)
    const { platformId, userId, projectId } = conversation
    const flowStep = conversation.source === AgentRunSource.FLOW_STEP
    const limit = await sydCopilotContext.incrementAndCheckLimit({ key: `syd:agent-rate:${platformId}:${flowStep ? projectId : userId}`, limit: flowStep ? 60 : 40, ttlSeconds: flowStep ? 60 : 600 })
    if (!limit.allowed) throw new ActivepiecesError({ code: ErrorCode.CHAT_MESSAGE_LIMIT_EXCEEDED, params: { limit: flowStep ? 60 : 40, windowSeconds: flowStep ? 60 : 600 } })
    const hosted = hostingConfiguration.getServiceMode() === 'hosted'
    const nativeFileIds = hosted ? nativeFilesForTurn(conversation.messages, addedNativeFileIds) : []
    if (hosted && nativeFileIds.length) await validateHostedAiFileIdsForActor({ platformId, userId, tokenVersion, projectId, fileIds: nativeFileIds, log })
    if (hosted) {
        assertHostedChatContext({ messages: conversation.messages, content })
        if (files?.length || jobConfig.tools.some(tool => tool.type === AgentToolType.MCP)) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'This hosted run supports configured Gadgets, Missions and knowledge sources. Remote MCP is not enabled. Upload attachments through the private Sydekyks file picker.' } })
        await hostedCopilotPayer({ platformId, projectId, provider: jobConfig.provider ?? undefined, configId: jobConfig.providerConfigId ?? undefined })
    }
    else {
        await sydCopilotContext.assertRunProviderConfigured({ platformId, provider: jobConfig.provider, providerConfigId: jobConfig.providerConfigId, scope: { type: 'project', projectId }, log })
        await assertCreditsAndAppSumoNotExceeded({ platformId, log })
    }
    const flowTools = await resolveFlowTools({ tools: jobConfig.tools, projectId, log })
    if (hosted) assertHostedChatContext({ messages: conversation.messages, content, configuration: { instructions: jobConfig.instructions, tools: jobConfig.tools, flowTools } })
    const runId = hosted && flowStep && waitpointId ? createHash('sha256').update(`agent-step:${platformId}:${projectId}:${waitpointId}`).digest('hex').slice(0, 21) : apId()
    await transaction(async (manager) => {
        const scoped = { id: conversation.id, platformId, userId, projectId }
        const row = await manager.getRepository(SydAgentConversationEntity).findOne({ where: scoped, lock: { mode: 'pessimistic_write' } })
        if (!row || (row.status === AgentConversationStatus.STREAMING && !(hosted && flowStep && row.activeRunId === runId))) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'This agent is already running' } })
        await manager.getRepository(SydAgentConversationEntity).update(scoped, { activeRunId: runId, status: AgentConversationStatus.STREAMING, ...(row.title === null && !flowStep ? { title: conversationTitle(content) } : {}) })
    })
    const snapshot = { conversationId: conversation.id, runId, platformId, userId, projectId, source: conversation.source, config, flowTools, waitpointId }
    const queued = await tryCatch(async () => {
        await distributedStore.put(snapshotKey({ conversationId: conversation.id, runId }), sanitizeObjectForPostgresql(snapshot), 86400)
        await distributedStore.put(activeSnapshotKey(conversation.id), { runId, platformId, projectId, userId }, 86400)
        await sydApprovalGate.clearCancel({ conversationId: conversation.id })
        await jobQueue(log).add({ id: runId, type: JobType.ONE_TIME, hostedOrigin: hostedOrigin ?? { type: 'user', userId, tokenVersion }, data: { schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_AGENT_RUN, conversationId: conversation.id, runId, platformId, userId, projectId, source: conversation.source, ...(hosted ? { agentInstructions: jobConfig.instructions, nativeFileIds, nativeWebSearch: nativeWebSearch === true } : {}), ...(conversation.agentId ? { agentId: conversation.agentId } : {}), ...(conversation.flowRunId ? { flowRunId: conversation.flowRunId } : {}), waitpointId, userMessage: content, files, tools: jobConfig.tools, flowTools, structuredOutput: jobConfig.structuredOutput, maxSteps: jobConfig.maxSteps, ...(jobConfig.provider ? { provider: jobConfig.provider } : {}), ...(jobConfig.providerConfigId ? { providerConfigId: jobConfig.providerConfigId } : {}), modelName: builder ? modelName ?? null : config.modelName ?? null } })
    })
    if (queued.error) {
        // Durable outbox ownership survives an ambiguous queue acknowledgement.
        // Return the accepted run and let recovery publish the same fenced job.
        if (hosted) {
            const dispatch = await databaseConnection().getRepository(HostingDispatchEntity).findOneBy({ platformId, projectId, rootKey: flowStep && waitpointId ? `agent-step:${waitpointId}` : `agent:${conversation.id}:${runId}` })
            if (dispatch && ['prepared', 'admitted', 'running'].includes(dispatch.state)) return { conversationId: conversation.id, runId }
        }
        await repo().update({ id: conversation.id, platformId, userId, activeRunId: runId }, { status: AgentConversationStatus.ERROR })
        throw queued.error
    }
    return { conversationId: conversation.id, runId }
}

async function snapshot({ conversationId, runId }: { conversationId: string, runId?: string }): Promise<AgentRunSnapshot> {
    if (hostingConfiguration.getServiceMode() === 'hosted') {
        const dispatch = await databaseConnection().getRepository(HostingDispatchEntity).createQueryBuilder('dispatch').where('dispatch.payload->>\'conversationId\' = :conversationId', { conversationId }).andWhere('dispatch.payload->>\'jobType\' = :jobType', { jobType: WorkerJobType.EXECUTE_AGENT_RUN }).andWhere(runId ? 'dispatch.payload->>\'runId\' = :runId' : 'TRUE', { runId }).orderBy('dispatch.created', 'DESC').getOne()
        const data = dispatch?.payload
        if (!dispatch || data?.jobType !== WorkerJobType.EXECUTE_AGENT_RUN || !data.runId || !data.projectId || data.source === AgentRunSource.CHAT || !data.source || data.agentInstructions === undefined) throw unavailable(conversationId)
        const row = await repo().findOneBy({ id: conversationId, platformId: dispatch.platformId, projectId: dispatch.projectId, userId: data.userId, activeRunId: data.runId, source: data.source })
        if (!row) throw unavailable(conversationId)
        return { conversationId, runId: data.runId, platformId: dispatch.platformId, projectId: dispatch.projectId, userId: data.userId, source: data.source, config: AgentConfig.parse({ instructions: data.agentInstructions, provider: data.provider, providerConfigId: data.providerConfigId, modelName: data.modelName, tools: data.tools, structuredOutput: data.structuredOutput, maxSteps: data.maxSteps }), flowTools: data.flowTools ?? [], waitpointId: data.waitpointId }
    }
    const scope = await distributedStore.get<Pick<AgentRunSnapshot, 'runId' | 'platformId' | 'projectId' | 'userId'>>(activeSnapshotKey(conversationId))
    if (!scope || (runId && scope.runId !== runId)) throw unavailable(conversationId)
    const row = await repo().findOneBy({ id: conversationId, platformId: scope.platformId, projectId: scope.projectId, userId: scope.userId })
    if (!row || row.source === AgentRunSource.CHAT || row.activeRunId !== scope.runId) throw unavailable(conversationId)
    const stored = await distributedStore.get<AgentRunSnapshot>(snapshotKey({ conversationId, runId: row.activeRunId }))
    if (!stored || stored.platformId !== row.platformId || stored.projectId !== row.projectId || stored.userId !== row.userId) throw unavailable(conversationId)
    return stored
}
function activeSnapshotKey(conversationId: string) {
    return `syd:agent-active-snapshot:${conversationId}`
}
function snapshotKey({ conversationId, runId }: { conversationId: string, runId: string }) {
    return `syd:agent-snapshot:${conversationId}:${runId}`
}
function unavailable(id: string): ActivepiecesError {
    return new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityType: 'AgentConversation', entityId: id } })
}

export const sydAgentRuntime = { repo, get, create, start, snapshot, resolveFlowTools, validateTools }
export type AgentRunSnapshot = { conversationId: string, runId: string, platformId: string, projectId: string, userId: string, source: AgentRunSource, config: AgentConfig, waitpointId?: string, flowTools: ResolvedAgentFlowTool[] }
