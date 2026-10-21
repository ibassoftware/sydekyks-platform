import { AIProviderName } from '@activepieces/core-utils'
import { AgentConversationStatus, AgentRunSource, WorkerJobType, WorkerToApiContract } from '@activepieces/shared'
import { aiKeyScope } from '../ai/ai-key-scope'
import { AIProviderEntity } from '../ai/ai-provider-entity'
import { databaseConnection } from '../database/database-connection'
import { sydApprovalGate } from '../syd/copilot/approval-gate'
import { SydAgentConversationEntity } from '../syd/copilot/models/agent-conversation.entity'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL, HostedAiInput } from './hosting-ai-policy'
import { hostingConfiguration } from './hosting-configuration'
import { HostingDispatchEntity } from './hosting-dispatch-entity'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { hostingFail, hostingTransactions as tx } from './hosting-transactions'

export function assertHostedChatContext({ messages, content }: { messages: unknown[], content: string }): void {
    // Leave room for the bounded system prompt, schemas and local tool results.
    // Refuse before claiming the conversation or reserving an execution.
    if (content.length > 32768 || messages.length >= 32 || Buffer.byteLength(JSON.stringify([...messages, { role: 'user', content }])) > 40 * 1024) hostingFail('HOSTING_CHAT_CONTEXT_LIMIT')
}

export async function hostedCopilotPayer({ platformId, projectId, provider, configId }: { platformId: string, projectId: string, provider?: string, configId?: string }): Promise<HostedAiInput['payer']> {
    if ((!provider || provider === AIProviderName.ACTIVEPIECES) && !configId) return { type: 'managed' }
    if (provider !== AIProviderName.DEEPSEEK || !configId) hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
    const row = await databaseConnection().getRepository(AIProviderEntity).findOneBy({ platformId, id: configId })
    if (!row || row.provider !== AIProviderName.DEEPSEEK || row.status !== 'active' || !aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId } }) || !aiKeyScope.keyOffersModel({ key: row, modelId: HOSTED_DEEPSEEK_MODEL }) || Object.keys(row.config).length) hostingFail('HOSTING_BYOK_SCOPE_DENIED')
    return { type: 'byok', configId }
}

export async function hostedCopilotScope({ admissionId, connectionId, input, spending = false }: { admissionId?: string, connectionId?: string, input?: Record<string, unknown>, spending?: boolean }) {
    if (!admissionId) hostingFail('HOSTING_AI_SEGMENT_DENIED')
    return tx.run({ dataSource: databaseConnection(), fn: async manager => {
        const peek = await manager.getRepository(HostingDispatchEntity).findOneBy({ admissionId })
        if (!peek) hostingFail('HOSTING_AI_SEGMENT_DENIED')
        const account = await tx.account({ manager, platformId: peek.platformId })
        const segment = await manager.getRepository(HostingDispatchEntity).findOneByOrFail({ id: peek.id })
        const data = segment.payload
        const now = await tx.now(manager)
        if (segment.state !== 'running' || segment.terminalReceipt || !segment.leaseUntil || segment.leaseUntil <= now || (connectionId && segment.connectionId !== connectionId) || data?.jobType !== WorkerJobType.EXECUTE_AGENT_RUN || !data.runId || !data.projectId) hostingFail('HOSTING_AI_SEGMENT_DENIED')
        const row = await manager.getRepository(data.source === AgentRunSource.CHAT ? SydConversationEntity : SydAgentConversationEntity).findOneBy({ id: data.conversationId, platformId: segment.platformId, userId: data.userId, source: data.source, activeRunId: data.runId })
        if (!row || (row.projectId && row.projectId !== segment.projectId)) hostingFail('HOSTING_AI_SEGMENT_DENIED')
        await tx.member({ manager, actor: { identityId: segment.identityId, platformId: segment.platformId, tokenVersion: segment.tokenVersion }, projectId: segment.projectId, write: true })
        if (spending) {
            tx.assertActive({ account, now }); if (row.status !== AgentConversationStatus.STREAMING || await sydApprovalGate.isCancelled({ conversationId: row.id, runId: data.runId })) hostingFail('HOSTING_AI_SEGMENT_DENIED')
        }
        for (const [key, expected] of Object.entries({ conversationId: data.conversationId, runId: data.runId, platformId: segment.platformId, projectId: segment.projectId, userId: data.userId, source: data.source, provider: data.provider ?? AIProviderName.ACTIVEPIECES, providerConfigId: data.providerConfigId ?? '', userMessage: data.userMessage, flowRunId: data.flowRunId, waitpointId: data.waitpointId })) {
            if (input && key in input && input[key] !== undefined && input[key] !== expected) hostingFail('HOSTING_AI_SEGMENT_DENIED')
        }
        return { segment, data, conversation: row }
    } })
}

const allowed = new Set(['getAgentConfig', 'sendAgentEvent', 'saveAgentMessages', 'updateAgentProgress', 'heartbeatAgentConversation', 'executeAgentTool', 'readAgentFile', 'saveAgentFile', 'sendAgentEmail', 'executePieceTool', 'executeKnowledgeBaseTool', 'executeFlowTool', 'updateFlowStepProgress', 'resumeFlowStep'])
const agentMethods = new Set([...allowed, 'readAgentFile', 'saveAgentFile', 'agentCreditsLeft', 'updateProjectContext', 'sendAgentEmail', 'executePieceTool', 'executeKnowledgeBaseTool', 'executeFlowTool', 'updateFlowStepProgress', 'resumeFlowStep', 'getPersonalizationConfig', 'getPersonalizationPrefillConfig', 'savePersonalizationResult', 'savePersonalizationPrefill', 'sendPersonalizationProgress'])
export function protectHostedCopilotRpc(handlers: WorkerToApiContract, connectionId?: string): WorkerToApiContract {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return handlers
    return new Proxy(handlers, { get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (typeof key !== 'string' || !agentMethods.has(key)) return value
        return async (input: Record<string, unknown>) => {
            if (!connectionId || !allowed.has(key)) hostingFail('HOSTING_TOOL_NOT_METERED')
            const scope = await hostedCopilotScope({ admissionId: typeof input.admissionId === 'string' ? input.admissionId : undefined, connectionId, input })
            if (key === 'getAgentConfig') {
                if (await sydApprovalGate.isCancelled({ conversationId: scope.conversation.id, runId: scope.data.runId })) hostingFail('HOSTING_AI_SEGMENT_DENIED')
                return value({ ...scope.data, admissionId: input.admissionId })
            }
            if (key === 'executeAgentTool') {
                const tools = new Set(['__cancel_check', '__approval_wait', '__store_pending_gate', '__get_selected_connection', '__get_available_connections', '__store_selected_connection', 'ap_list_agents', 'ap_create_agent', 'ap_update_agent', 'ap_add_agent_tool', 'ap_remove_agent_tool'])
                if (typeof input.toolName !== 'string' || !tools.has(input.toolName) || !input.toolInput || typeof input.toolInput !== 'object') hostingFail('HOSTING_TOOL_NOT_METERED')
                const toolInput = input.toolInput as Record<string, unknown>
                for (const [field, expected] of Object.entries({ conversationId: scope.data.conversationId, runId: scope.data.runId, projectId: scope.segment.projectId, platformId: scope.segment.platformId, userId: scope.data.userId })) {
                    if (field in toolInput && toolInput[field] !== undefined && toolInput[field] !== expected) hostingFail('HOSTING_AI_SEGMENT_DENIED')
                }
                input = { ...input, toolInput: { ...toolInput, conversationId: scope.data.conversationId, runId: scope.data.runId, projectId: scope.segment.projectId } }
            }
            if (['executePieceTool', 'executeKnowledgeBaseTool', 'executeFlowTool', 'sendAgentEmail'].includes(key)) {
                await hostedCopilotScope({ admissionId: input.admissionId as string, connectionId, spending: true })
            }
            if (['resumeFlowStep', 'updateFlowStepProgress'].includes(key) && scope.data.source !== AgentRunSource.FLOW_STEP) hostingFail('HOSTING_AI_SEGMENT_DENIED')
            // Transcript/progress payloads are callbacks, not authority to start any cost path.
            return value({ ...input, conversationId: scope.data.conversationId, runId: scope.data.runId, platformId: scope.segment.platformId, projectId: scope.segment.projectId, userId: scope.data.userId, source: scope.data.source })
        }
    } })
}

export async function assertHostedCopilotModel({ admissionId, request }: { admissionId: string, request: HostedAiInput }) {
    const { segment, data } = await hostedCopilotScope({ admissionId, spending: true })
    const payer = await hostedCopilotPayer({ platformId: segment.platformId, projectId: segment.projectId, provider: data.provider, configId: data.providerConfigId })
    if (request.model !== (payer.type === 'managed' ? HOSTED_MANAGED_MODEL : HOSTED_DEEPSEEK_MODEL) || JSON.stringify(payer) !== JSON.stringify(request.payer) || !request.callKey.startsWith('copilot:') || request.attempt !== 0) hostingFail('HOSTING_AI_PAYER_CONFLICT')
    // A preceding uncertain call cannot be disguised as a fresh continuation.
    if (await databaseConnection().getRepository(HostingModelCallEntity).existsBy({ segmentId: segment.id, state: 'uncertain' })) hostingFail('HOSTING_AI_OUTCOME_UNCERTAIN')
    return segment
}
