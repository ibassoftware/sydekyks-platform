import { AIProviderName } from '@activepieces/core-utils'
import { agentAiUtils, aiUtils } from '@activepieces/server-utils'
import { AgentEvent, AgentEventType, AgentRunSource, EngineResponseStatus, ExecuteAgentRunJobData, LATEST_JOB_DATA_SCHEMA_VERSION, MAX_CORE_TOOLS, WorkerJobType } from '@activepieces/shared'
import { tool } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { agentMcpClient } from '../../../../../../src/lib/execute/jobs/ee/agent/agent-mcp-client'
import { executeAgentRunJob } from '../../../../../../src/lib/execute/jobs/ee/agent/execute-agent-run'
import { JobContext } from '../../../../../../src/lib/execute/types'

afterEach(() => vi.restoreAllMocks())

describe('skills through the production chat job', () => {
    it('loads a skill, validates a flow by ID only, and streams the real tool identity', async () => {
        let step = 0
        const calls = [
            { toolCallId: 'load', toolName: 'ap_load_skill', input: '{"skills":["flow_building"]}' },
            { toolCallId: 'validate', toolName: 'ap_lazy_tool', input: '{"tool":"ap_validate_flow","input":{"flowId":"flow-1"}}' },
        ]
        const model = new MockLanguageModelV4({
            doStream: async () => {
                const call = calls[step++]
                return { stream: convertArrayToReadableStream([
                    { type: 'stream-start', warnings: [] },
                    ...(call ? [{ type: 'tool-call' as const, ...call }] : [
                        { type: 'text-start' as const, id: 'answer' },
                        { type: 'text-delta' as const, id: 'answer', delta: 'The flow is valid.' },
                        { type: 'text-end' as const, id: 'answer' },
                    ]),
                    { type: 'finish', finishReason: { unified: call ? 'tool-calls' : 'stop', raw: call ? 'tool-calls' : 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
                ]) }
            },
        })
        vi.spyOn(aiUtils, 'createModel').mockReturnValue(model as unknown as ReturnType<typeof aiUtils.createModel>)
        vi.spyOn(aiUtils, 'supportsWebSearch').mockReturnValue(false)
        vi.spyOn(agentAiUtils, 'affordableOutputTokens').mockResolvedValue(1024)
        const validate = vi.fn<(input: unknown, options: unknown) => Promise<{ valid: boolean }>>(async () => ({ valid: true }))
        vi.spyOn(agentMcpClient, 'connect').mockResolvedValue({ mcpClient: null, mcpToolSet: {
            ap_validate_flow: tool({ inputSchema: z.object({ flowId: z.string().optional(), folderName: z.string().optional() }), execute: validate }),
        } })
        const sendAgentEvent = vi.fn<(input: { event: AgentEvent }) => Promise<void>>(async () => undefined)
        const saveAgentMessages = vi.fn<(input: unknown) => Promise<void>>(async () => undefined)
        const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log }
        const ctx = { log, apiClient: {
            getAgentConfig: async () => ({
                credentials: { provider: AIProviderName.OPENAI },
                modelId: 'gpt-4.1', fastModelId: 'gpt-4.1-mini', source: AgentRunSource.CHAT,
                tier: { id: 'smart', modelId: 'gpt-4.1', thinkingBudget: 0 },
                systemPrompt: 'Validate the specified draft. Do not publish.', guides: { build_flow: 'Validate the draft before finishing.' },
                aiTools: {}, projects: [{ id: 'project-1' }],
                messages: [{ role: 'user', content: 'Validate flow-1.' }], allMessages: [{ role: 'user', content: 'Validate flow-1.' }],
                previousUiMessages: [{ role: 'user', parts: [] }, { role: 'user', parts: [] }],
            }),
            agentCreditsLeft: async () => 100,
            sendAgentEvent, saveAgentMessages,
            updateAgentProgress: async () => undefined,
        } } as unknown as JobContext
        const data = { schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_AGENT_RUN, conversationId: 'conversation-1', runId: 'run-1', projectId: 'project-1', platformId: 'platform-1', userId: 'user-1', userMessage: 'Validate flow-1.', modelName: null } as ExecuteAgentRunJobData

        const result = await executeAgentRunJob.execute(ctx, data)

        expect(result.status).toBe(EngineResponseStatus.OK)
        expect(validate).toHaveBeenCalledTimes(1)
        expect(validate.mock.calls[0]?.[0]).toEqual({ flowId: 'flow-1' })
        expect(model.doStreamCalls.every(call => (call.tools?.length ?? 0) <= MAX_CORE_TOOLS)).toBe(true)
        expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('Skills and tools')
        const chunks = sendAgentEvent.mock.calls.flatMap(([input]) => input.event.type === AgentEventType.CHUNK ? input.event.data : [])
        expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-input-available', toolName: 'ap_validate_flow', input: { flowId: 'flow-1' } }))
        expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'tool-input-available', toolName: 'ap_lazy_tool' }))
        expect(JSON.stringify(saveAgentMessages.mock.calls)).toContain('The flow is valid.')
    })
})
