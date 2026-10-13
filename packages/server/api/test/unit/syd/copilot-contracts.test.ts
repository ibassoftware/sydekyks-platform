import { readFileSync } from 'node:fs'
import { AIProviderConfig, AIProviderName } from '@activepieces/core-utils'
import { PersistedAgentMessage, ApEdition, AgentRunSource, AiProviderModelScope, AIProviderModelType, aiProviderUtils, AppConnectionStatus, AppConnectionType, ChatPersonalizationStatus, PersistedAgentPartType, PersistedAgentRole, PersistedToolCallStatus } from '@activepieces/shared'
import Fastify from 'fastify'
import { MockLanguageModelV4 } from 'ai/test'
import { ModelMessage } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { sydCopilotAvailability } from '../../../src/app/syd/copilot/copilot-availability'
import { system } from '../../../src/app/helper/system/system'
import { sydChatModelSelection } from '../../../src/app/syd/copilot/chat-model-selection'
import { sydCopilotContext } from '../../../src/app/syd/copilot/copilot-context'
import { sydConversationCompaction } from '../../../src/app/syd/copilot/conversation-compaction'
import { sydConversationFiles } from '../../../src/app/syd/copilot/conversation-files'
import { sydConversationHistory } from '../../../src/app/syd/copilot/history/conversation-history'
import { sydMemoryEditor } from '../../../src/app/syd/copilot/memory-editor'
import { sydProfileNormalization } from '../../../src/app/syd/copilot/personalization/profile-normalization'
import { sydCopilotPrompt } from '../../../src/app/syd/copilot/prompt/copilot-prompt'
import { sydRunContext } from '../../../src/app/syd/copilot/prompt/run-context'
import { sydUserIdentity } from '../../../src/app/syd/copilot/prompt/user-identity'
import { sydRunOperations } from '../../../src/app/syd/copilot/rpc/run-operations'
import { sydCopilotActions } from '../../../src/app/syd/copilot/tools/copilot-actions'
import { sydToolUsage } from '../../../src/app/syd/copilot/tool-usage'

describe('Syd history and file contracts', () => {
    it('retains ordinary value-bearing tool outputs and only unwraps JSON envelopes', () => {
        for (const [output, expected] of [
            [{ value: 42, unit: 'USD' }, '{"value":42,"unit":"USD"}'],
            [{ type: 'json', value: { count: 3 } }, '{"count":3}'],
            [{ type: 'text', value: 'hello' }, '{"type":"text","value":"hello"}'],
        ]) {
            const history = sydConversationHistory.reconstruct([{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'count', input: { limit: 3 } }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', output }] }])
            expect(history[0].toolCalls?.[0]).toMatchObject({ title: 'count', input: { limit: 3 }, output: expected })
        }
    })

    it('groups reasoning and tool-only assistant steps without mutating the input', () => {
        const source = [{ role: 'assistant', content: 'Working' }, { role: 'assistant', content: [{ type: 'reasoning', text: 'Thoughts' }, { type: 'tool-call', toolCallId: 'one', toolName: 'lookup' }] }, { role: 'user', content: [{ type: 'text', text: 'Next' }] }]
        const snapshot = JSON.stringify(source)
        expect(sydConversationHistory.reconstruct(source)).toEqual([{ role: 'assistant', content: 'Working', thoughts: 'Thoughts', toolCalls: [{ toolCallId: 'one', title: 'lookup', status: 'completed', input: undefined }] }, { role: 'user', content: 'Next' }])
        expect(JSON.stringify(source)).toBe(snapshot)
    })

    it('extracts text from a real PDF and builds multimodal attachment content', async () => {
        const data = readFileSync('packages/server/api/test/fixtures/syd-text.pdf').toString('base64')
        expect(await sydConversationFiles.extractPdfText(data)).toContain('Syd PDF fixture')
        const result = await sydConversationFiles.buildUserContentWithFiles({ text: 'Read these', files: [{ name: '../report.pdf', mimeType: 'application/pdf', data }, { name: 'image.png', mimeType: 'image/png', data: 'aW1hZ2U=' }], attachmentNote: 'Saved file references' })
        expect(result).toEqual([{ type: 'text', text: expect.stringContaining('Syd PDF fixture') }, { type: 'file', mediaType: 'image/png', data: 'aW1hZ2U=' }])
        expect(sydConversationFiles.sanitizeFileName('../report/é.pdf')).toBe('.._report__.pdf')
        expect(sydConversationFiles.buildAttachmentNote([{ fileId: 'file', name: 'Report', mimeType: 'text/plain' }])).toContain('fileId `file`')
    })
})

describe('Syd model and compaction contracts', () => {
    it('uses only the CHAT tier surface and rejects other run sources', () => {
        expect(sydChatModelSelection.surfaceOf({ source: AgentRunSource.CHAT })).toBe('chat')
        for (const source of [AgentRunSource.AGENT, AgentRunSource.AGENT_BUILDER, AgentRunSource.FLOW_STEP]) expect(() => sydChatModelSelection.surfaceOf({ source })).toThrow()
    })

    it('treats an explicitly empty manual text catalog as authoritative', () => {
        const config: AIProviderConfig = { apiKeyHeader: 'Authorization', baseUrl: 'https://example.com', models: [{ modelId: 'image-model', modelName: 'Image', modelType: AIProviderModelType.IMAGE }] }
        expect(sydChatModelSelection.manualTextModelCatalog({ config })).toEqual([])
        expect(() => sydChatModelSelection.resolveModelIdForProvider({ provider: AIProviderName.CUSTOM, selectedModel: null, surface: 'chat', config })).toThrow()
    })

    it('honors a key allow-list and chooses an available fallback', () => {
        expect(sydChatModelSelection.pickAllowedModel({ provider: AIProviderName.OPENAI, selectedModel: 'denied', candidates: ['denied', 'allowed'], modelScope: 'selected', modelIds: ['allowed'] })).toBe('allowed')
        expect(() => sydChatModelSelection.pickAllowedModel({ provider: AIProviderName.OPENAI, selectedModel: null, candidates: ['denied'], modelScope: 'selected', modelIds: [] })).toThrow()
        expect(sydChatModelSelection.resolveModelIdForAnalytics({ provider: null, selectedModel: 'private-unrecognized-model', surface: 'chat' })).toBeNull()
    })

    it('runs each current OpenAI selection and honors a restricted key without reverting silently', () => {
        for (const selectedModel of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
            expect(sydChatModelSelection.resolveModelIdForProvider({ provider: AIProviderName.OPENAI, selectedModel, surface: 'chat', modelScope: 'selected', modelIds: [selectedModel] })).toBe(selectedModel)
            expect(sydChatModelSelection.resolveModelIdForAnalytics({ provider: null, selectedModel, surface: 'chat' })).toBe(selectedModel)
        }
        expect(sydChatModelSelection.resolveModelIdForProvider({ provider: AIProviderName.OPENAI, selectedModel: null, surface: 'chat' })).toBe('gpt-6-luna')
        expect(sydChatModelSelection.resolveModelIdForProvider({ provider: AIProviderName.OPENAI, selectedModel: 'gpt-6-astra', surface: 'chat', modelScope: 'selected', modelIds: ['gpt-5.5'] })).toBe('gpt-5.5')
    })

    it('applies CE, EE, Cloud, plan and embedded admission consistently', () => {
        const edition = vi.spyOn(system, 'getEdition')
        for (const value of [ApEdition.COMMUNITY, ApEdition.ENTERPRISE, ApEdition.CLOUD]) {
            edition.mockReturnValue(value)
            expect(sydCopilotAvailability.resolveChatEnabledForUser({ platform: { plan: { chatEnabled: true } }, isEmbedded: false })).toBe(true)
            expect(sydCopilotAvailability.resolveChatEnabledForUser({ platform: { plan: { chatEnabled: false } }, isEmbedded: false })).toBe(value === ApEdition.COMMUNITY)
            expect(sydCopilotAvailability.resolveChatEnabledForUser({ platform: { plan: { chatEnabled: true } }, isEmbedded: true })).toBe(false)
        }
        edition.mockRestore()
    })
    it('summarizes with the real AI SDK and retains the prior summary on model failure', async () => {
        const messages: ModelMessage[] = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) }))
        const provider = AIProviderName.ANTHROPIC
        const params = { messages, provider, reservedTokens: aiProviderUtils.getMaxContextTokens({ provider }) - 500, existingSummary: 'Prior', summarizedUpToIndex: 0, log: Fastify().log }
        const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }
        const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'Summary' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) })
        expect(await sydConversationCompaction.compactMessages({ ...params, model })).toMatchObject({ summary: 'Summary' })
        const failed = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('Provider failed') } })
        expect(await sydConversationCompaction.compactMessages({ ...params, model: failed })).toEqual({ summary: 'Prior', summarizedUpToIndex: 0 })
    })

    it('does not split assistant tool calls from their tool results', () => {
        const messages: ModelMessage[] = [{ role: 'user', content: 'Start' }, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: {} }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'read', output: { type: 'json', value: {} } }] }, { role: 'user', content: 'Continue' }]
        expect(sydConversationCompaction.snapToSafeMessageBoundary({ messages, rawCutoff: 2 })).toBe(1)
        expect(sydConversationCompaction.snapToSafeMessageBoundary({ messages, rawCutoff: 99 })).toBe(3)
    })

    it('budgets Unicode text, fair summary shares and reserved tokens', () => {
        expect(sydConversationCompaction.tokensIn('aaaa')).toBe(1)
        expect(sydConversationCompaction.tokensIn('😀中文')).toBe(3)
        expect(sydConversationCompaction.truncateToTokens({ text: '😀中文', maxTokens: 1 })).toContain('😀…')
        expect(sydConversationCompaction.fairShareCap({ lengths: [1, 100], budget: 10 })).toBe(9)
        expect(sydConversationCompaction.contextBudget({ provider: AIProviderName.ANTHROPIC, reservedTokens: Number.MAX_SAFE_INTEGER })).toBe(0)
        expect(sydConversationCompaction.shouldCompact({ provider: AIProviderName.ANTHROPIC, messageCount: 5, reservedTokens: 0, estimatedTokens: Number.MAX_SAFE_INTEGER })).toBe(false)
    })

    it('fits recent history with a visible omission note and preserves a newest oversized message failure', () => {
        const provider = AIProviderName.ANTHROPIC
        const reservedTokens = aiProviderUtils.getMaxContextTokens({ provider }) - 100
        const messages: ModelMessage[] = [{ role: 'user', content: 'x'.repeat(1000) }, { role: 'assistant', content: 'Old reply' }, { role: 'user', content: 'New request' }]
        const result = sydConversationCompaction.buildCompactedPayload({ provider, reservedTokens, messages, summary: null, summarizedUpToIndex: null })
        expect(JSON.stringify(result)).toContain('left out to fit')
        expect(JSON.stringify(result)).toContain('New request')
        expect(() => sydConversationCompaction.buildCompactedPayload({ provider, reservedTokens, messages: [{ role: 'user', content: 'x'.repeat(1000) }], summary: null, summarizedUpToIndex: null })).toThrow()
    })
})

describe('Syd memory, identity and connection contracts', () => {
    it('normalizes and caps memory, parses LLM JSON, and preserves concurrent edits', () => {
        expect(sydMemoryEditor.naiveSplit('1. Alpha\n- Beta\n* Alpha')).toEqual({ instructions: null, memories: ['Alpha', 'Beta'] })
        expect(sydMemoryEditor.parseJsonObject({ raw: 'Here is JSON: {"memories":["Alpha"]}', schema: sydMemoryEditor.MemoriesSchema })).toEqual({ memories: ['Alpha'] })
        expect(sydMemoryEditor.parseJsonObject({ raw: 'invalid {', schema: sydMemoryEditor.MemoriesSchema })).toBeNull()
        expect(sydCopilotContext.mergeMemories({ base: ['Removed', 'Retained'], current: ['Retained', 'Concurrent'], incoming: ['Removed', 'New'] })).toEqual(['New', 'Concurrent'])
        expect(sydCopilotContext.capMemories({ instructions: '   ', memories: [' A ', 'A', ''] })).toEqual({ instructions: null, memories: ['A'] })
    })

    it('normalizes role and website inputs while rejecting local addresses', () => {
        expect(sydProfileNormalization.normalizeRoleTitle({ input: '  vp   of sales ' })).toBe('VP of Sales')
        expect(sydProfileNormalization.normalizeWebsite({ input: 'HTTPS://www.Example.com/path?query=yes' })).toBe('example.com')
        for (const input of ['localhost', 'foo.local', 'foo.localhost', '127.0.0.1', 'not a site']) expect(sydProfileNormalization.normalizeWebsite({ input })).toBeNull()
        expect(sydUserIdentity.companyHintFromEmail({ email: 'person@gmail.com' })).toBeNull()
        expect(sydUserIdentity.companyHintFromEmail({ email: 'person@example.com' })).toEqual({ domain: 'example.com', company: 'Example' })
    })

    it('keeps branded identity and capability/memory notes scoped to CHAT', () => {
        const note = sydUserIdentity.buildNote({ firstName: 'Rein', lastName: 'Duque', email: 'person@example.com', platformName: 'Sydekyks', identity: { company: { name: 'Example', description: 'A team', industry: 'Software' }, role: 'CTO' } })
        expect(note).toContain('Sydekyks')
        expect(note).toContain('CTO')
        const capabilities = sydRunContext.buildCapabilitiesNote({ currentDate: '6 October 2026', searchAvailable: false, fetchAvailable: false, scrapeAvailable: false, imageAvailable: false, imageEditAvailable: false, emailAvailable: false, userEmail: 'person@example.com' })
        const instructions = `Custom instructions${note}${capabilities}`
        expect(sydRunContext.stripRunNotes(instructions)).toBe('Custom instructions')
        expect(sydRunContext.stripRunNotes(`Custom instructions${note}`)).toBe(`Custom instructions${note}`)
        expect(capabilities).toContain('unavailable')
        expect(sydRunContext.buildMemoryNote({ instructions: 'Be concise', memories: ['One fact'] })).toContain('One fact')
        expect(sydCopilotPrompt.buildSystemPrompt({ projects: [], currentProjectId: null, frontendUrl: 'https://example.com', templates: { system: '{{PROJECT_LIST}}\n{{PROJECT_CONTEXT}}\n{{FRONTEND_URL}}', noProject: 'Choose a project' } })).toContain('Choose a project')
    })

    it('recognizes expired non-refreshable OAuth accounts and retains granted scopes', () => {
        const value = { claimed_at: 1, expires_in: 1, scope: 'read write' }
        expect(sydCopilotActions.resolveConnectionInfo({ status: AppConnectionStatus.ACTIVE, type: AppConnectionType.OAUTH2, value })).toEqual({ status: AppConnectionStatus.ERROR, grantedScopes: ['read', 'write'] })
        expect(sydCopilotActions.resolveConnectionInfo({ status: AppConnectionStatus.ACTIVE, type: AppConnectionType.OAUTH2, value: { ...value, refresh_token: 'refresh' } }).status).toBe(AppConnectionStatus.ACTIVE)
    })

    it('extracts code artifacts without mutating output and bounds inline result text', () => {
        const output = { total: 1, files: [{ name: 'report.txt', mimeType: 'text/plain', base64: 'SGVsbG8=' }, { invalid: true }] }
        expect(sydCopilotActions.extractFilesFromOutput(output)).toEqual({ files: [output.files[0]], rest: { total: 1 } })
        expect(output.files).toHaveLength(2)
        expect(sydCopilotActions.decodeBase64('data:text/plain;base64,SGVsbG8=')?.toString()).toBe('Hello')
        expect(sydCopilotActions.buildCodeResultText({ rest: 'x'.repeat(30_000), producedFiles: [] }).length).toBeLessThan(21_000)
        expect(sydRunOperations.outcomeOfToolResult({ isError: true })).toBe('FAILED')
        expect(sydRunOperations.outcomeOfToolResult({ content: [{ type: 'text', text: '✅ Done' }] })).toBe('SUCCEEDED')
    })

    it('bills completed tools in the latest turn and excludes already-at-cost tools', () => {
        const call = (name: string, output: unknown = null): Extract<PersistedAgentMessage['parts'][number], { type: PersistedAgentPartType.TOOL_CALL }> => ({ type: PersistedAgentPartType.TOOL_CALL, toolCallId: name, toolName: name, title: name, status: PersistedToolCallStatus.COMPLETED, input: {}, output })
        expect(sydToolUsage.countBillableToolCallsInLatestTurn({ messages: [{ role: PersistedAgentRole.ASSISTANT, parts: [call('ap_run_code')] }, { role: PersistedAgentRole.USER, parts: [] }, { role: PersistedAgentRole.ASSISTANT, parts: [call('ap_web_search', { billedAtCost: true }), call('mcp__ap_list_flows'), call('ap_run_code')] }] })).toBe(2)
    })
})
