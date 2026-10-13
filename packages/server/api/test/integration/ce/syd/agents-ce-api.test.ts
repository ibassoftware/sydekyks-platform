import { AIProviderName, apId } from '@activepieces/core-utils'
import { agentAiUtils, aiUtils } from '@activepieces/server-utils'
import { Agent, AgentConversation, AgentConversationStatus, AgentIcon, AgentRunSource, AgentVisibility, AgentToolType, KnowledgeBaseSourceType, FilterOperator, ColorName, EngineResponseStatus, ExecuteAgentRunJobData, McpAuthType, McpProtocol, FlowRunStatus, FlowVersionState, PrincipalType } from '@activepieces/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { executeAgentRunJob } from '../../../../../worker/src/lib/execute/jobs/ee/agent/execute-agent-run'
import { JobContext } from '../../../../../worker/src/lib/execute/types'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { distributedStore, redisConnections } from '../../../../src/app/database/redis-connections'
import { pubsub } from '../../../../src/app/helper/pubsub'
import { billingProvider } from '../../../../src/app/platform/billing-provider'
import { sydAgentRuntime } from '../../../../src/app/syd/copilot/agent-runtime'
import { sydAgentSecrets } from '../../../../src/app/syd/copilot/agent-secrets'
import { sydConfiguredToolsRpc } from '../../../../src/app/syd/copilot/rpc/configured-tools-rpc'
import { sydCopilotMcp } from '../../../../src/app/syd/copilot/mcp/copilot-mcp'
import { jobQueue } from '../../../../src/app/workers/job-queue/job-queue'
import { createHandlers } from '../../../../src/app/workers/rpc/worker-rpc-service'
import { generateMockToken } from '../../../helpers/auth'
import { createMockFlow, createMockFlowRun, createMockFlowVersion, createMockWaitpoint, createMockSolutionAndSave, mockAndSaveAIProvider } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment } from '../../../helpers/test-setup'

vi.mock('../../../../src/app/platform/billing-and-telemetry', () => ({ trackBillingAndSendTelemetry: vi.fn().mockResolvedValue(undefined) }))

let app: FastifyInstance
beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
    const base = billingProvider.get(app.log)
    vi.spyOn(billingProvider, 'get').mockReturnValue({ ...base, getCreditsAndAppSumoState: async () => ({ credits: { blocked: false, metered: false, usage: 0, limit: 100, remaining: 100, unlimited: false }, appSumo: { blocked: false, metered: false, usage: 0, limit: 0, remaining: 0, unlimited: true } }) })
})
afterAll(async () => {
    await jobQueue(app.log).close()
    await app.close()
    await pubsub.close()
    await redisConnections.destroy()
    await databaseConnection().destroy()
    vi.restoreAllMocks()
})

async function createAgent(ctx: TestContext): Promise<Agent> {
    await mockAndSaveAIProvider({ platformId: ctx.platform.id, provider: AIProviderName.OPENAI, config: {}, enabledForChat: true, modelScope: 'selected', modelIds: ['gpt-6-luna'] })
    const response = await ctx.post('/v1/agents', { projectId: ctx.project.id, displayName: 'Greeting agent', icon: AgentIcon.SPARKLES, color: ColorName.PURPLE, visibility: AgentVisibility.PROJECT, draft: { instructions: 'Say hello in one sentence.', tools: [], structuredOutput: [], maxSteps: 5 } })
    expect(response.statusCode).toBe(201)
    return response.json<Agent>()
}

describe('owned saved agents in Community Edition', () => {
    it('supports CRUD and draft publication with scoped keys and hides stored tool credentials', async () => {
        const owner = await createTestContext(app, { plan: { agentsEnabled: false, chatEnabled: false } })
        const outsider = await createTestContext(app)
        const agent = await createAgent(owner)
        expect(agent.draft.modelName).toBe('gpt-6-luna')
        expect((await outsider.get(`/v1/agents/${agent.id}`)).statusCode).toBeGreaterThanOrEqual(400)
        const draft = { ...agent.draft, tools: [{ type: 'MCP', toolName: 'remote', serverUrl: 'https://example.com/mcp', protocol: McpProtocol.STREAMABLE_HTTP, auth: { type: McpAuthType.ACCESS_TOKEN, accessToken: 'private-test-token' } }] }
        const updated = await owner.post(`/v1/agents/${agent.id}`, { draft, goLive: false })
        expect(updated.statusCode).toBe(200)
        expect(JSON.stringify(updated.json())).not.toContain('private-test-token')
        const stored = await sydAgentRuntime.repo().manager.getRepository<Agent>('agent').findOneByOrFail({ id: agent.id, projectId: owner.project.id })
        expect(JSON.stringify(stored.draft)).toContain('private-test-token')
        const redacted = sydAgentSecrets.redact(stored)
        expect((await owner.post(`/v1/agents/${agent.id}`, { draft: redacted.draft, goLive: false })).statusCode).toBe(200)
        const restored = await sydAgentRuntime.repo().manager.getRepository<Agent>('agent').findOneByOrFail({ id: agent.id, projectId: owner.project.id })
        expect(JSON.stringify(restored.draft)).toContain('private-test-token')
        expect((await owner.post(`/v1/agents/${agent.id}/publish`, {})).json().published.instructions).toBe(agent.draft.instructions)
        expect((await owner.post(`/v1/agents/${agent.id}/unpublish`, {})).json().published).toBeNull()
        expect((await owner.delete(`/v1/agents/${agent.id}`)).statusCode).toBe(204)
    })

    it('runs direct agent chat through the actual worker and keeps builder history separate', async () => {
        const owner = await createTestContext(app)
        const outsider = await createTestContext(app)
        const agent = await createAgent(owner)
        const created = await owner.post('/v1/agents/conversations', { agentId: agent.id })
        expect(created.statusCode).toBe(201)
        const conversation = created.json<AgentConversation>()
        const builder = (await owner.post('/v1/agents/conversations', { agentId: agent.id, builder: true })).json<AgentConversation>()
        expect(builder.source).toBe(AgentRunSource.AGENT_BUILDER)
        expect((await outsider.get(`/v1/agents/conversations/${conversation.id}`)).statusCode).toBe(404)
        const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
        const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: 'Hello from the configured agent.' }, { type: 'text-end', id: 'reply' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }] }) }) })
        const modelSpy = vi.spyOn(aiUtils, 'createModel').mockReturnValue(model)
        const budgets = vi.spyOn(agentAiUtils, 'affordableOutputTokens').mockResolvedValue(4000)
        const mcp = vi.spyOn(sydCopilotMcp, 'getCredentials').mockResolvedValue({ mcpServerUrl: null, mcpToken: null })
        const admitted = await owner.post(`/v1/agents/conversations/${conversation.id}/messages`, { content: 'Hello' })
        expect(admitted.statusCode, admitted.body).toBe(200)
        const queued = await (await jobQueue(app.log).getOrCreateQueue({ queueName: 'workerJobs' })).getJob(admitted.json().runId)
        expect(queued).not.toBeNull()
        const data = ExecuteAgentRunJobData.parse(queued?.data)
        const apiClient = createHandlers(app.log)
        const ctx: JobContext = { apiClient, log: app.log, workerIndex: 0, jobId: data.runId ?? '', lastAttempt: true, engineToken: 'test', internalApiUrl: 'http://localhost', publicApiUrl: 'http://localhost', runtime: { execute: async () => { throw new Error('Unexpected engine execution') }, getActiveExecutors: () => [], prewarm: async () => { throw new Error('Unexpected prewarm') }, shutdown: async () => undefined }, resolver: { resolve: async () => { throw new Error('No configured pieces to load') } } }
        expect((await executeAgentRunJob.execute(ctx, data)).status).toBe(EngineResponseStatus.OK)
        const stored = (await owner.get(`/v1/agents/conversations/${conversation.id}`)).json<AgentConversation>()
        expect(stored.status).toBe(AgentConversationStatus.IDLE)
        expect(JSON.stringify(stored.uiMessages)).toContain('Hello from the configured agent.')
        const listed = (await owner.get('/v1/agents/conversations', { agentId: agent.id })).json()
        expect(listed.data.map((row: { id: string }) => row.id)).toEqual([conversation.id])
        expect((await owner.get(`/v1/agents/conversations/${builder.id}/messages`)).json()).toEqual({ data: [] })
        modelSpy.mockRestore(); budgets.mockRestore(); mcp.mockRestore()
    })

    it('admits an engine run once and resumes only its own waiting mission step', async () => {
        const owner = await createTestContext(app)
        await createAgent(owner)
        const flow = createMockFlow({ projectId: owner.project.id })
        const version = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.DRAFT })
        const run = createMockFlowRun({ projectId: owner.project.id, flowId: flow.id, flowVersionId: version.id, status: FlowRunStatus.PAUSED, finishTime: undefined })
        const point = createMockWaitpoint({ projectId: owner.project.id, flowRunId: run.id, status: 'PENDING' })
        const manager = databaseConnection().manager
        await manager.getRepository('flow').save(flow)
        await manager.getRepository('flow_version').save(version)
        await manager.getRepository('flow_run').save(run)
        await manager.getRepository('waitpoint').save(point)
        const admissionId = apId()
        const token = await generateMockToken({ type: PrincipalType.ENGINE, id: admissionId, projectId: owner.project.id, platform: { id: owner.platform.id } })
        const body = { instruction: 'Say hello', flowRunId: run.id, waitpointId: point.id, provider: AIProviderName.OPENAI, modelName: 'gpt-6-luna', maxSteps: 5, tools: [] }
        const admitted = await app.inject({ method: 'POST', url: '/api/v1/agents/runs', headers: { authorization: `Bearer ${token}` }, body })
        expect(admitted.statusCode, admitted.body).toBe(200)
        const duplicate = await app.inject({ method: 'POST', url: '/api/v1/agents/runs', headers: { authorization: `Bearer ${token}` }, body })
        expect(duplicate.statusCode).toBeGreaterThanOrEqual(400)
        const scope = admitted.json<{ conversationId: string, runId: string }>()
        const rpc = sydConfiguredToolsRpc(app.log)
        await expect(rpc.resumeFlowStep({ conversationId: scope.conversationId, flowRunId: run.id, waitpointId: apId(), output: {} })).rejects.toThrow()
        await rpc.resumeFlowStep({ conversationId: scope.conversationId, flowRunId: run.id, waitpointId: point.id, output: { status: 'SUCCESS', steps: [] } })
        const resumed = await manager.getRepository('waitpoint').findOneBy({ id: point.id, projectId: owner.project.id })
        expect(resumed).toBeNull()
        const history = await sydAgentRuntime.repo().findOneByOrFail({ id: scope.conversationId, platformId: owner.platform.id, projectId: owner.project.id })
        expect(history.source).toBe(AgentRunSource.FLOW_STEP)
        expect(history.flowRunId).toBe(run.id)
    })

    it('searches a configured table in the run project without needing an embedding key', async () => {
        const owner = await createTestContext(app)
        const agent = await createAgent(owner)
        const data = await createMockSolutionAndSave({ projectId: owner.project.id, platformId: owner.platform.id, userId: owner.user.id })
        const tool = { type: AgentToolType.KNOWLEDGE_BASE, toolName: 'policies', sourceType: KnowledgeBaseSourceType.TABLE, sourceId: data.table.id, sourceName: data.table.name }
        expect((await owner.post(`/v1/agents/${agent.id}`, { draft: { ...agent.draft, tools: [tool] }, goLive: false })).statusCode).toBe(200)
        const conversation = (await owner.post('/v1/agents/conversations', { agentId: agent.id })).json<AgentConversation>()
        const sent = await owner.post(`/v1/agents/conversations/${conversation.id}/messages`, { content: 'Look up this record' })
        expect(sent.statusCode).toBe(200)
        const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
        const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({ filters: [{ fieldId: data.cell.fieldId, operator: FilterOperator.EQ, value: String(data.cell.value) }] }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) })
        const modelSpy = vi.spyOn(aiUtils, 'createModel').mockReturnValue(model)
        const result = await sydConfiguredToolsRpc(app.log).executeKnowledgeBaseTool({ conversationId: conversation.id, runId: sent.json().runId, toolName: 'policies', knowledgeBaseFileId: data.table.id, query: 'Find the configured record' })
        expect(result).toMatchObject({ result: { tableName: data.table.name, records: [expect.objectContaining({ id: data.cell.recordId })] } })
        await expect(sydConfiguredToolsRpc(app.log).executeKnowledgeBaseTool({ conversationId: conversation.id, runId: sent.json().runId, toolName: 'policies', knowledgeBaseFileId: apId(), query: 'Read another table' })).rejects.toThrow()
        modelSpy.mockRestore()
    })

    it('rejects unconfigured tools and cross-flow progress and binds a run to its admitted draft', async () => {
        const owner = await createTestContext(app)
        const agent = await createAgent(owner)
        const conversation = (await owner.post('/v1/agents/conversations', { agentId: agent.id })).json<AgentConversation>()
        const sent = await owner.post(`/v1/agents/conversations/${conversation.id}/messages`, { content: 'Hello' })
        expect(sent.statusCode).toBe(200)
        await owner.post(`/v1/agents/${agent.id}`, { draft: { ...agent.draft, instructions: 'Changed after admission' }, goLive: false })
        const snapshot = await sydAgentRuntime.snapshot({ conversationId: conversation.id, runId: sent.json().runId })
        expect(snapshot.config.instructions).toBe('Say hello in one sentence.')
        const rpc = sydConfiguredToolsRpc(app.log)
        await expect(rpc.executePieceTool({ conversationId: conversation.id, runId: sent.json().runId, toolName: 'forged', instruction: 'Run', modelId: 'gpt-6-luna', piece: { pieceName: 'fake', actionName: 'fake', pieceVersion: '1' } })).rejects.toThrow()
        await expect(rpc.updateFlowStepProgress({ conversationId: conversation.id, flowRunId: apId(), sequence: 1, output: {} })).rejects.toThrow()
        await expect(rpc.resumeFlowStep({ conversationId: conversation.id, flowRunId: apId(), waitpointId: apId(), output: {} })).rejects.toThrow()
    })
})
