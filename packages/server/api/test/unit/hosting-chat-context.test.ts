import { asSchema } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { agentWorkerTools } from '../../../worker/src/lib/execute/jobs/ee/agent/agent-worker-tools'
import { createHostedBuilderTools } from '../../../worker/src/lib/execute/jobs/ee/agent/hosted-builder-tools'
import { HOSTED_AI_CONTEXT_TOKENS, HOSTED_AI_MAX_MESSAGES, HOSTED_AI_REQUEST_MAX_BYTES, HostedAiInput, hostedAiInputBound, HostedAiRequest } from '../../src/app/hosting/hosting-ai-policy'
import { hostedBuilderConfiguration } from '../../src/app/hosting/hosting-builder-tools'
import { assertHostedChatContext, HOSTED_CHAT_HISTORY_MAX_BYTES, HOSTED_CHAT_HISTORY_MAX_MESSAGES } from '../../src/app/hosting/hosting-copilot'
import { hostedCopilotPrompt } from '../../src/app/hosting/hosting-copilot-prompt'

vi.mock('../../src/app/project/project-service', () => ({ projectService: () => ({ getOneOrThrow: async () => ({ platformId: 'platform' }) }) }))
vi.mock('../../src/app/mcp/mcp-permissions', () => ({ resolvePermissionChecker: async () => ({ check: () => null }) }))
vi.mock('../../src/app/mcp/mcp-service', () => ({ mcpServerService: () => ({ getByProjectId: async () => ({ id: 'mcp', disabledTools: [] }), listPlatformDisabledTools: async () => [] }) }))

function pairedHistory(steps: number): HostedAiInput['messages'] {
    const messages: HostedAiInput['messages'] = [{ role: 'user', content: 'Build my seven-step customer lead Mission. Preserve every mapping and the final notification.' }]
    for (let step = 0; step < steps; step++) {
        for (let action = 0; action < 5; action++) {
            const id = `step-${step}-${action}`
            messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'ap_get_piece_props', arguments: JSON.stringify({ pieceName: '@activepieces/piece-tables', actionOrTriggerName: 'tables-create-records', type: 'action' }) } }] })
            messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ step, action, tableId: `customer-table-${step}`, schema: { name: 'records', type: 'array', fields: ['Name', 'Company', 'Email'] }, userMapping: '{{trigger[\'output\'].body.email}}', metadata: 'Exact catalogue and customer mapping data. '.repeat(15) }) })
        }
    }
    return messages
}

async function fullBuilderTools() {
    const definitions = await hostedBuilderConfiguration({ projectId: 'project', platformId: 'platform', userId: 'user', log: { error: vi.fn(), debug: vi.fn() } as never })
    const waitForApproval = async () => ({ outcome: 'denied' } as never)
    const eventEmitter = { emitActionPreview: vi.fn() } as never
    const execute = async () => ({})
    const tools = {
        ...agentWorkerTools.createDisplayTools({ waitForApproval, displayToolTimeoutMs: 1000 }),
        ...agentWorkerTools.createThinkingTools(),
        ...agentWorkerTools.createPhaseTools({ onPhaseChange: () => undefined }),
        ...agentWorkerTools.createBuildPlanTools({ eventEmitter, getProjectId: () => 'project' }),
        ...agentWorkerTools.createAgentSurfaceTools({ executeTool: execute, taintState: { tainted: false }, eventEmitter, waitForApproval }),
        ...agentWorkerTools.createEmailTools({ sendEmail: async () => ({} as never), eventEmitter, userEmail: 'test@example.com', waitForApproval }),
        ...createHostedBuilderTools({ definitions, execute, taintState: { tainted: false }, eventEmitter, waitForApproval, storePendingGate: async () => undefined }),
    }
    return Promise.all(Object.entries(tools).map(async ([name, definition]) => ({ type: 'function', function: { name, description: definition.description, parameters: await asSchema(definition.inputSchema).jsonSchema } })))
}

describe('coherent hosted chat continuation envelope', () => {
    it('accepts the reported 42-message/41 KiB history without mutating its tool pairs or user intent', () => {
        const messages = [...pairedHistory(4), { role: 'assistant' as const, content: 'The first four steps are saved.' }]
        // The production regression was 42 saved ModelMessages and 41,258 bytes.
        const first = messages[0]
        if (first.role !== 'user') throw new Error('Expected user intent')
        first.content += 'x'.repeat(Math.max(0, 41258 - Buffer.byteLength(JSON.stringify(messages))))
        const saved = JSON.stringify(messages)
        expect(messages).toHaveLength(42)
        expect(Buffer.byteLength(saved)).toBeGreaterThanOrEqual(41258)
        expect(() => assertHostedChatContext({ messages, content: 'Continue building the remaining steps.' })).not.toThrow()
        expect(JSON.stringify(messages)).toBe(saved)
    })
    it('admits a seven-step continuation with complete real schemas and over 64 wire messages', async () => {
        const messages = pairedHistory(7)
        const content = 'Continue with exactly those customer mappings; do not replace the saved draft.'
        const saved = JSON.stringify(messages)
        expect(messages.length).toBeGreaterThan(64)
        expect(() => assertHostedChatContext({ messages, content })).not.toThrow()
        const tools = await fullBuilderTools()
        expect(tools.length).toBeGreaterThan(30)
        const system = hostedCopilotPrompt({ projectId: 'project', projectName: 'Home', now: new Date('2026-10-24') })
        const request = HostedAiRequest.parse({ callKey: 'copilot:0', attempt: 0, payer: { type: 'managed' }, model: 'sydekyks', messages: [{ role: 'system', content: system }, ...messages, { role: 'user', content }], tools, max_tokens: 4096 })
        expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(HOSTED_AI_REQUEST_MAX_BYTES)
        expect(hostedAiInputBound(request) + request.max_tokens).toBeLessThan(HOSTED_AI_CONTEXT_TOKENS)
        expect(JSON.stringify(messages)).toBe(saved)
        const calls = request.messages.flatMap(message => message.role === 'assistant' ? message.tool_calls?.map(call => call.id) ?? [] : [])
        const results = request.messages.flatMap(message => message.role === 'tool' ? [message.tool_call_id] : [])
        expect(calls).toEqual(results)
        expect(request.messages).toEqual([{ role: 'system', content: system }, ...messages, { role: 'user', content }])
    })
    it('preserves a large seven-step history through three further full-context follow-ups', async () => {
        const messages = pairedHistory(7)
        const tools = await fullBuilderTools()
        const system = hostedCopilotPrompt({ projectId: 'project', projectName: 'Home', now: new Date('2026-10-24') })
        for (let turn = 0; turn < 3; turn++) {
            messages.push({ role: 'user', content: `Requested follow-up ${turn}: preserve the original seven-step Mission and every mapping.` })
            for (let action = 0; action < 3; action++) {
                const id = `followup-${turn}-${action}`
                messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'ap_flow_structure', arguments: JSON.stringify({ flowId: 'same-saved-mission' }) } }] })
                messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ flowId: 'same-saved-mission', turn, action, exactSavedSettings: 'unique full saved settings '.repeat(800) }) })
            }
            messages.push({ role: 'assistant', content: `Follow-up ${turn} saved to the same Mission.` })
            const saved = JSON.stringify(messages)
            const content = 'Continue reviewing this same Mission without dropping earlier instructions.'
            expect(() => assertHostedChatContext({ messages, content })).not.toThrow()
            const request = HostedAiRequest.parse({ callKey: `copilot:${turn}`, payer: { type: 'managed' }, model: 'sydekyks', messages: [{ role: 'system', content: system }, ...messages, { role: 'user', content }], tools, max_tokens: 4096 })
            expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(HOSTED_AI_REQUEST_MAX_BYTES)
            expect(hostedAiInputBound(request) + request.max_tokens).toBeLessThanOrEqual(HOSTED_AI_CONTEXT_TOKENS)
            expect(request.messages.slice(1, -1)).toEqual(messages)
            expect(JSON.stringify(messages)).toBe(saved)
        }
        expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(192 * 1024)
    })
    it('reserves schema/result headroom and refuses before admission instead of discarding saved history', () => {
        expect(HOSTED_CHAT_HISTORY_MAX_BYTES).toBe(HOSTED_AI_REQUEST_MAX_BYTES / 2)
        expect(HOSTED_CHAT_HISTORY_MAX_MESSAGES).toBeLessThan(HOSTED_AI_MAX_MESSAGES)
        const bytes = [{ role: 'user', content: 'x'.repeat(HOSTED_CHAT_HISTORY_MAX_BYTES) }]
        const saved = JSON.stringify(bytes)
        expect(() => assertHostedChatContext({ messages: bytes, content: 'Continue' })).toThrow('HOSTING_CHAT_CONTEXT_LIMIT')
        expect(JSON.stringify(bytes)).toBe(saved)
        const messages = Array.from({ length: HOSTED_CHAT_HISTORY_MAX_MESSAGES }, () => ({ role: 'user', content: 'short' }))
        expect(() => assertHostedChatContext({ messages, content: 'Continue' })).toThrow('HOSTING_CHAT_CONTEXT_LIMIT')
        expect(() => assertHostedChatContext({ messages: [], content: 'x'.repeat(32769) })).toThrow('HOSTING_CHAT_CONTEXT_LIMIT')
    })
    it('funds the full approved input window for the bounded 1 MiB envelope, including output and attachments', () => {
        const request = HostedAiRequest.parse({ callKey: 'copilot:0', payer: { type: 'managed' }, model: 'sydekyks', max_tokens: 4096, messages: Array.from({ length: HOSTED_AI_MAX_MESSAGES }, () => ({ role: 'user', content: 'x' })), tools: Array.from({ length: 128 }, (_, index) => ({ type: 'function', function: { name: `gadget_${index}`, parameters: { type: 'object', $comment: '' } } })) })
        if (!request.tools) throw new Error('Expected tools')
        request.tools[0].function.parameters.$comment = 'x'.repeat(HOSTED_AI_REQUEST_MAX_BYTES - Buffer.byteLength(JSON.stringify(request)))
        expect(Buffer.byteLength(JSON.stringify(request))).toBe(HOSTED_AI_REQUEST_MAX_BYTES)
        expect(hostedAiInputBound(request) + request.max_tokens).toBe(HOSTED_AI_CONTEXT_TOKENS)
        expect(hostedAiInputBound(request, 900000) + request.max_tokens).toBe(HOSTED_AI_CONTEXT_TOKENS)
        request.tools[0].function.parameters.$comment += 'x'
        expect(() => hostedAiInputBound(request)).toThrow('HOSTING_AI_REQUEST_LIMIT')
        expect(() => HostedAiRequest.parse({ ...request, messages: [...request.messages, { role: 'user', content: 'one too many' }] })).toThrow()
    })
})
