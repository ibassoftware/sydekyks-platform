import { AgentConfig, AgentConversationStatus, AgentRunSource } from '@activepieces/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ add: vi.fn(), put: vi.fn(), update: vi.fn(), transaction: vi.fn(), conversation: {} as Record<string, unknown> }))
vi.mock('../../src/app/core/db/transaction', () => ({ transaction: async (fn: (manager: unknown) => unknown) => {
    mocks.transaction(); return fn({ getRepository: () => ({ findOne: async () => mocks.conversation, update: mocks.update }) })
} }))
vi.mock('../../src/app/database/redis-connections', () => ({ distributedStore: { put: mocks.put }, redisConnections: { getRedisType: () => 'STANDALONE' } }))
vi.mock('../../src/app/database/database-connection', () => ({ databaseConnection: () => ({ getRepository: () => ({ update: mocks.update }) }) }))
vi.mock('../../src/app/hosting/hosting-configuration', () => ({ hostingConfiguration: { getServiceMode: () => 'hosted' } }))
vi.mock('../../src/app/hosting/hosting-builder-tools', () => ({ hostedBuilderToolNames: new Set(), executeHostedBuilderTool: vi.fn() }))
vi.mock('../../src/app/hosting/hosting-copilot', async original => ({ ...await original<typeof import('../../src/app/hosting/hosting-copilot')>(), hostedCopilotPayer: async () => ({ type: 'managed' }) }))
vi.mock('../../src/app/workers/job-queue/job-queue', () => ({ JobType: { ONE_TIME: 'ONE_TIME' }, jobQueue: () => ({ add: mocks.add }) }))
vi.mock('../../src/app/syd/copilot/copilot-context', () => ({ sydCopilotContext: { incrementAndCheckLimit: async () => ({ allowed: true }) } }))
vi.mock('../../src/app/syd/copilot/approval-gate', () => ({ sydApprovalGate: { clearCancel: async () => undefined } }))
vi.mock('../../src/app/syd/copilot/tools/chat-agent-administration', () => ({ sydChatAgentAdministration: vi.fn() }))
vi.mock('../../src/app/platform/billing-provider', () => ({ assertCreditsAndAppSumoNotExceeded: vi.fn() }))
vi.mock('../../src/app/flows/flow/flow.service', () => ({ flowService: vi.fn() }))
vi.mock('../../src/app/mcp/mcp-server-builder', () => ({ extractMcpTriggerInput: vi.fn() }))
import { HOSTED_CHAT_HISTORY_MAX_BYTES } from '../../src/app/hosting/hosting-copilot'
import { sydAgentRuntime } from '../../src/app/syd/copilot/agent-runtime'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
beforeEach(() => {
    vi.clearAllMocks()
    mocks.add.mockResolvedValue(undefined); mocks.put.mockResolvedValue(undefined); mocks.update.mockResolvedValue({ affected: 1 })
    mocks.conversation = { id: 'c'.repeat(21), platformId: 'p'.repeat(21), projectId: 'j'.repeat(21), userId: 'u'.repeat(21), source: AgentRunSource.AGENT, status: AgentConversationStatus.ERROR, activeRunId: 'old', title: 'Synthetic mail conversation', messages: [{ role: 'user', content: 'Keep the original request.' }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'mail', toolName: 'gmail_search', output: { type: 'json', value: { body: 'x'.repeat(73468) } } }] }] }
})
describe('saved Agent large-context admission', () => {
    it('admits the reported 77 KB mail history and preserves the saved messages', async () => {
        const saved = JSON.stringify(mocks.conversation.messages)
        const result = await sydAgentRuntime.start({ conversation: mocks.conversation as never, config: AgentConfig.parse({ instructions: 'Use the saved context faithfully.' }), content: 'Continue with the three emails.', log })
        expect(result.runId).toHaveLength(21)
        expect(mocks.add).toHaveBeenCalledOnce()
        expect(JSON.stringify(mocks.conversation.messages)).toBe(saved)
    })
    it('admits a large new prompt without the old Agent-specific cap', async () => {
        const content = 'Synthetic user document. '.repeat(90000)
        await sydAgentRuntime.start({ conversation: mocks.conversation as never, config: AgentConfig.parse({ instructions: '' }), content, log })
        expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userMessage: content }) }))
    })
    it('rejects beyond the large shared boundary before a claim, reservation or queue submission', async () => {
        await expect(sydAgentRuntime.start({ conversation: mocks.conversation as never, config: AgentConfig.parse({ instructions: '' }), content: 'x'.repeat(HOSTED_CHAT_HISTORY_MAX_BYTES), log })).rejects.toThrow('HOSTING_CHAT_CONTEXT_LIMIT')
        expect(mocks.transaction).not.toHaveBeenCalled()
        expect(mocks.add).not.toHaveBeenCalled()
        expect(mocks.put).not.toHaveBeenCalled()
    })
})
