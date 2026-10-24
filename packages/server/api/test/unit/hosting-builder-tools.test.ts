import { readFileSync } from 'node:fs'
import { AgentRunSource } from '@activepieces/shared'
import { asSchema } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { agentWorkerTools } from '../../../worker/src/lib/execute/jobs/ee/agent/agent-worker-tools'
import { createHostedBuilderTools } from '../../../worker/src/lib/execute/jobs/ee/agent/hosted-builder-tools'

const state = vi.hoisted(() => ({ platformId: 'platform', denied: false, disabled: [] as string[], read: false, decision: 'pending' as unknown, consumed: false, created: [] as unknown[], updated: [] as unknown[] }))
vi.mock('../../src/app/project/project-service', () => ({ projectService: () => ({ getOneOrThrow: async () => ({ platformId: state.platformId }) }) }))
vi.mock('../../src/app/mcp/mcp-permissions', () => ({ resolvePermissionChecker: async () => ({ check: () => state.denied ? { isError: true } : null }) }))
vi.mock('../../src/app/mcp/mcp-service', () => ({ mcpServerService: () => ({ getByProjectId: async (projectId: string) => ({ id: 'mcp', projectId, disabledTools: state.disabled }), listPlatformDisabledTools: async () => [] }) }))
vi.mock('../../src/app/syd/copilot/rpc/run-operations', () => ({ sydRunOperations: { turnHasRead: async () => state.read, markTurnAsHavingRead: async () => {
    state.read = true
} } }))
vi.mock('../../src/app/syd/copilot/approval-gate', () => ({ sydApprovalGate: { checkDecision: async () => state.decision, consumeApproval: async () => {
    state.consumed = true; return true
} } }))
vi.mock('../../src/app/flows/flow/flow.service', () => ({ flowService: () => ({ create: async (input: unknown) => {
    state.created.push(input); return { id: 'mission', externalId: 'mission-ext', version: { displayName: 'Lead capture' } }
}, getOnePopulated: async ({ projectId, id }: { projectId: string, id: string }) => projectId === 'project' && id === 'mission' ? { id, version: { displayName: 'Lead capture', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } } } : null }) }))
vi.mock('../../src/app/tables/table/table.service', () => ({ tableService: { create: async (input: unknown) => {
    state.created.push(input); return { id: 'table', externalId: 'table-ext', name: 'Leads' }
} } }))
vi.mock('../../src/app/tables/field/field.service', () => ({ fieldService: { getAll: async () => [{ id: 'field', externalId: 'field-ext', name: 'Email', type: 'TEXT' }] } }))

import { HOSTED_AI_REQUEST_MAX_BYTES, HostedAiInput, hostedAiInputBound, HostedAiRequest } from '../../src/app/hosting/hosting-ai-policy'
import { executeHostedBuilderTool, hostedBuilderConfiguration, hostedBuilderInputSchema, hostedBuilderToolNames } from '../../src/app/hosting/hosting-builder-tools'
import { hostedCopilotPrompt } from '../../src/app/hosting/hosting-copilot-prompt'
import { mcpUtils } from '../../src/app/mcp/tools/mcp-utils'
import { staticMcpSchemaScope } from '../../src/app/mcp/tools/static-schema-scope'

const scope = { projectId: 'project', platformId: 'platform', userId: 'user', log: { error: vi.fn(), debug: vi.fn() } as never }
const invoke = (toolName: string, toolInput: Record<string, unknown> = {}, source = AgentRunSource.CHAT) => executeHostedBuilderTool({ ...scope, source, toolName, toolInput, conversationId: 'conversation', runId: 'run' })
beforeEach(() => {
    state.platformId = 'platform'; state.denied = false; state.disabled = []; state.read = false; state.decision = 'pending'; state.consumed = false; state.created = []; state.updated = []
})

describe('admitted hosted builder surface', () => {
    it('includes actual Mission and Tables tools, with bounded static schemas and no execution/remote tools', async () => {
        const tools = await hostedBuilderConfiguration(scope)
        expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['ap_build_flow', 'ap_create_flow', 'ap_update_trigger', 'ap_add_step', 'ap_create_table', 'ap_insert_records', 'ap_get_piece_props']))
        for (const name of ['ap_run_action', 'ap_test_flow', 'ap_test_step', 'ap_retry_run', 'ap_lock_and_publish', 'ap_resolve_property_options', 'ap_execute_action', 'ap_run_code']) expect(hostedBuilderToolNames.has(name)).toBe(false)
        const build = tools.find(t => t.name === 'ap_build_flow')!.inputSchema as { required: string[], properties: { steps: { items: { properties: { type: { enum: string[] }, stepLocationRelativeToParent: { default: string } } } } } }
        expect(build.required).toEqual(expect.arrayContaining(['flowName', 'trigger', 'steps']))
        expect(build.properties.steps.items.properties.type.enum).toContain('PIECE')
        expect(build.properties.steps.items.properties.stepLocationRelativeToParent.default).toBe('AFTER')
        const schema = tools.find(t => t.name === 'ap_get_piece_props')!
        expect(Object.keys((schema.inputSchema as { properties: object }).properties)).toEqual(['pieceName', 'actionOrTriggerName', 'type'])
        expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(40000)
    })
    it('retains bounded CODE binding/reference hints for all three draft editors', async () => {
        const tools = await hostedBuilderConfiguration(scope)
        let extraBytes = 0
        for (const name of ['ap_build_flow', 'ap_add_step', 'ap_update_step']) {
            const schema = structuredClone(tools.find(tool => tool.name === name)!.inputSchema)
            const before = Buffer.byteLength(JSON.stringify(schema))
            const properties = schema.properties as Record<string, Record<string, unknown>>
            const fields = name === 'ap_build_flow'
                ? (properties.steps.items as { properties: Record<string, Record<string, unknown>> }).properties
                : properties
            expect(fields.input.description).toContain('explicitly bind every key')
            expect(fields.input.description).toContain(mcpUtils.STEP_REFERENCE_HINT)
            expect(fields.sourceCode.description).toContain('not automatic variables')
            delete fields.input.description
            delete fields.sourceCode.description
            extraBytes += before - Buffer.byteLength(JSON.stringify(schema))
        }
        expect(extraBytes).toBeLessThan(2400)
    })
    it('preserves executable constraints and a property literally named description', () => {
        const schema = hostedBuilderInputSchema({ title: 'ap_add_step', inputSchema: {
            description: z.string().min(3).describe('Annotation to omit, not the property itself'),
            mode: z.enum(['first', 'second']).default('first'),
            input: z.record(z.string(), z.number().min(1)).optional(),
            sourceCode: z.string().min(4).optional(),
        } })
        const properties = schema.properties as Record<string, Record<string, unknown>>
        expect(schema.required).toContain('description')
        expect(schema.required).not.toContain('input')
        expect(properties.description).toEqual({ type: 'string', minLength: 3 })
        expect(properties.mode).toMatchObject({ enum: ['first', 'second'], default: 'first' })
        expect(properties.input.additionalProperties).toMatchObject({ type: 'number', minimum: 1 })
        expect(properties.sourceCode).toMatchObject({ type: 'string', minLength: 4 })
    })
    it('fits the complete hosted tools and a short conversation inside the gateway limit', async () => {
        const definitions = await hostedBuilderConfiguration(scope)
        const waitForApproval = async () => ({ outcome: 'denied' } as never)
        const eventEmitter = { emitActionPreview: vi.fn() } as never
        const executeTool = async () => ({})
        const taintState = { tainted: false }
        const tools = {
            ...agentWorkerTools.createDisplayTools({ waitForApproval, displayToolTimeoutMs: 1000 }),
            ...agentWorkerTools.createThinkingTools(),
            ...agentWorkerTools.createPhaseTools({ onPhaseChange: () => undefined }),
            ...agentWorkerTools.createBuildPlanTools({ eventEmitter, getProjectId: () => 'project' }),
            ...agentWorkerTools.createAgentSurfaceTools({ executeTool, taintState, eventEmitter, waitForApproval }),
            ...agentWorkerTools.createEmailTools({ sendEmail: async () => ({} as never), eventEmitter, userEmail: 'test@example.com', waitForApproval }),
            ...createHostedBuilderTools({ definitions, execute: executeTool, taintState, eventEmitter, waitForApproval, storePendingGate: async () => undefined }),
        }
        const wireTools = await Promise.all(Object.entries(tools).map(async ([name, tool]) => ({ type: 'function', function: { name, description: tool.description, parameters: await asSchema(tool.inputSchema).jsonSchema } })))
        const payload = { model: 'sydekyks', messages: [{ role: 'system', content: hostedCopilotPrompt({ projectId: 'project', projectName: 'Home', now: new Date('2026-10-22') }) }, { role: 'user', content: 'Build a lead capture webhook saving name, company and email in a Leads table.' }], tools: wireTools }
        expect(wireTools.length).toBeGreaterThan(30)
        expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(65536)
        // Real webhook/Tables metadata from the local catalogue, after the hosted
        // adapter. Exercise the continuation that production's first smoke missed.
        const catalogue = JSON.parse(readFileSync(new URL('../fixtures/hosted-builder-catalogue.json', import.meta.url), 'utf8')) as Array<{ toolName: string, toolInput: Record<string, unknown>, result: unknown }>
        const messages: HostedAiInput['messages'] = [...payload.messages]
        for (const [index, entry] of catalogue.entries()) {
            messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `catalogue-${index}`, type: 'function', function: { name: entry.toolName, arguments: JSON.stringify(entry.toolInput) } }] })
            messages.push({ role: 'tool', tool_call_id: `catalogue-${index}`, content: JSON.stringify(entry.result) })
        }
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'table', type: 'function', function: { name: 'ap_create_table', arguments: JSON.stringify({ name: 'Leads', fields: [{ name: 'Name', type: 'TEXT' }, { name: 'Company', type: 'TEXT' }, { name: 'Email', type: 'TEXT' }] }) } }] })
        messages.push({ role: 'tool', tool_call_id: 'table', content: JSON.stringify({ content: [{ type: 'text', text: 'Table Leads created' }], structuredContent: { id: 'table-id', externalId: 'table-external', fields: [{ name: 'Name', type: 'TEXT' }, { name: 'Company', type: 'TEXT' }, { name: 'Email', type: 'TEXT' }] } }) })
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'mission', type: 'function', function: { name: 'ap_build_flow', arguments: JSON.stringify({ flowName: 'Lead capture', trigger: { pieceName: '@activepieces/piece-webhook', triggerName: 'catch_webhook', input: { authType: 'none' } }, steps: [{ type: 'PIECE', displayName: 'Save lead', pieceName: '@activepieces/piece-tables', actionName: 'tables-create-records', input: { table_id: 'table-external', values: {}, records: [{ Name: '{{trigger[\'output\'].body.name}}', Company: '{{trigger[\'output\'].body.company}}', Email: '{{trigger[\'output\'].body.email}}' }] } }] }) } }] })
        messages.push({ role: 'tool', tool_call_id: 'mission', content: JSON.stringify({ content: [{ type: 'text', text: 'Lead capture draft created: https://app.sydekyks.com/projects/project/flows/mission' }], structuredContent: { flowId: 'mission', stepCount: 2, validCount: 2, invalidSteps: [], skippedSteps: [] } }) })
        const continuation = HostedAiRequest.parse({ ...payload, messages, callKey: 'copilot:5', attempt: 0, payer: { type: 'managed' }, max_tokens: 4096 })
        // Fixed CODE wiring hints and truthful file capabilities add under 4 KiB
        // to the original fixture, with ample room below the 192 KiB gateway.
        expect(Buffer.byteLength(JSON.stringify(continuation))).toBeLessThan(60 * 1024)
        expect(Buffer.byteLength(JSON.stringify(continuation))).toBeLessThan(HOSTED_AI_REQUEST_MAX_BYTES)
        expect(hostedAiInputBound(continuation) + continuation.max_tokens).toBeLessThan(1048576)
        expect(messages[1].content).toBe(payload.messages[1].content)
    })
    it('marks Mission structure inspection as an untrusted read before any later mutation', async () => {
        await invoke('ap_flow_structure', { flowId: 'mission' })
        expect(state.read).toBe(true)
        await expect(invoke('ap_create_flow', { flowName: 'Not approved' })).rejects.toThrow('APPROVAL_REQUIRED')
    })
    it('dispatches Mission and Leads table creation to the existing scoped service handlers', async () => {
        const mission = await invoke('ap_create_flow', { flowName: 'Lead capture' })
        const table = await invoke('ap_create_table', { name: 'Leads', fields: [{ name: 'Email', type: 'TEXT' }] })
        expect(mission.structuredContent?.flowId).toBe('mission')
        expect(table.structuredContent?.externalId).toBe('table-ext')
        expect(state.created).toHaveLength(2)
        expect(state.created[0]).toMatchObject({ projectId: 'project', ownerId: 'user' })
        expect(state.created[1]).toMatchObject({ projectId: 'project', request: { projectId: 'project', name: 'Leads' } })
    })
    it('reloads disabled tools, actor permissions and platform ownership on every call', async () => {
        expect((await hostedBuilderConfiguration(scope)).length).toBeGreaterThan(0)
        state.disabled = ['ap_create_flow']
        await expect(invoke('ap_create_flow', { flowName: 'Denied' })).rejects.toThrow('TOOL_ACCESS_DENIED')
        state.disabled = []; state.denied = true
        await expect(invoke('ap_create_table', { name: 'Denied', fields: [] })).rejects.toThrow('TOOL_ACCESS_DENIED')
        state.denied = false; state.platformId = 'foreign'
        await expect(invoke('ap_create_flow', { flowName: 'Denied' })).rejects.toThrow('PROJECT_ACCESS_DENIED')
        expect(state.created).toHaveLength(0)
    })
    it('rejects source escalation, project substitutions, unknown fields and execution routes', async () => {
        await expect(invoke('ap_create_flow', { flowName: 'Denied' }, AgentRunSource.AGENT)).rejects.toThrow('TOOL_NOT_METERED')
        await expect(invoke('ap_create_flow', { flowName: 'Denied', projectId: 'foreign' })).rejects.toThrow('SEGMENT_DENIED')
        await expect(invoke('ap_create_flow', { flowName: 'Denied', remoteUrl: 'https://example.com' })).rejects.toThrow()
        await expect(invoke('ap_test_flow', { flowId: 'mission' })).rejects.toThrow('TOOL_NOT_METERED')
        expect(state.created).toHaveLength(0)
    })
    it('requires exact one-time approval after a stored-data read', async () => {
        state.read = true
        const args = { name: 'Leads', fields: [{ name: 'Email', type: 'TEXT' }] }
        await expect(invoke('ap_create_table', args)).rejects.toThrow('APPROVAL_REQUIRED')
        state.decision = { approved: true, approvedToolName: 'ap_create_table', approvedConversationId: 'conversation', approvedRunId: 'other', approvedInput: args }
        await expect(invoke('ap_create_table', { ...args, approvedGateId: 'gate' })).rejects.toThrow('APPROVAL_REQUIRED')
        state.decision = { ...(state.decision as object), approvedRunId: 'run' }
        await invoke('ap_create_table', { ...args, approvedGateId: 'gate' })
        expect(state.consumed).toBe(true)
        expect(state.created).toHaveLength(1)
    })
    it('static builder schema scope never invokes metadata or engine dynamic callbacks', async () => {
        const settings = await staticMcpSchemaScope.run(true, () => mcpUtils.resolveDynamicPropertySettings({ pieceName: 'must-not-load', pieceVersion: '1', componentName: 'create', componentType: 'action', input: { fields: { Email: 'test' } }, projectId: 'project', platformId: 'platform', log: scope.log }))
        expect(settings).toEqual({})
        expect(staticMcpSchemaScope.getStore()).toBeUndefined()
    })
    it('instructs current tools, Sydekyks branding and honest draft/test boundaries despite old chat history', () => {
        const prompt = hostedCopilotPrompt({ projectId: 'project', projectName: 'Home', now: new Date('2026-10-22') })
        expect(prompt).toContain('ap_set_phase')
        expect(prompt).toContain('Prefer ap_build_flow')
        expect(prompt).toContain('Never describe this platform as Activepieces')
        expect(prompt).toContain('testing and publication must be completed in its editor')
        expect(prompt).toContain('CODE steps receive only their explicit input map')
        expect(prompt).toContain('Configuration validation does not prove successful execution')
        expect(prompt).toContain('An ordinary Form upload URL or file object is not such an ID')
        expect(prompt).toContain('no verified Form-upload-to-AI ingestion adapter')
        expect(prompt).toContain('Chat attachments still support file understanding')
        expect(prompt).toContain('never replace BYOK with hosted defaults')
    })
})
