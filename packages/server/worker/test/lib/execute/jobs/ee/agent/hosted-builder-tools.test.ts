import { AgentRunSource, agentToolPhases } from '@activepieces/shared'
import { ToolExecutionOptions } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { createHostedBuilderTools } from '../../../../../../src/lib/execute/jobs/ee/agent/hosted-builder-tools'
import { withGadgetIdentifiers } from '../../../../../../src/lib/execute/jobs/ee/agent/tools/gadget-identifiers'
import { agentToolPolicy } from '../../../../../../src/lib/execute/jobs/ee/agent/agent-tool-policy'

const definitions = [
    { name: 'ap_build_flow', description: 'Build a Mission draft.', inputSchema: { type: 'object', properties: { flowName: { type: 'string' } } }, readOnly: false },
    { name: 'ap_flow_structure', description: 'Read a Mission.', inputSchema: { type: 'object' }, readOnly: true },
    { name: 'ap_create_table', description: 'Create a Table.', inputSchema: { type: 'object' }, readOnly: false },
    { name: 'ap_update_record', description: 'Update a row.', inputSchema: { type: 'object' }, readOnly: false },
]
const options = { toolCallId: 'tool-call', messages: [] } as ToolExecutionOptions
function setup(approved = true) {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'saved' }] }))
    const eventEmitter = { emitActionPreview: vi.fn() }
    const waitForApproval = vi.fn(async () => ({ outcome: approved ? 'approved' : 'denied' } as never))
    const storePendingGate = vi.fn(async () => undefined)
    const taintState = { tainted: false }
    const tools = createHostedBuilderTools({ definitions, execute, taintState, eventEmitter: eventEmitter as never, waitForApproval, storePendingGate })
    return { tools, execute, taintState, waitForApproval, storePendingGate }
}

describe('hosted builder worker bridge', () => {
    it('attaches creation tools to CHAT, after entering build phase; no remote MCP is required', () => {
        const { tools } = setup()
        const empty = { local: {}, display: {}, crossProject: {}, web: {}, thinking: {}, phase: {}, buildPlan: {}, email: {}, agentSurface: {}, mcp: tools, configuredPiece: {}, configuredFlow: {}, knowledgeBase: {}, completion: {} }
        const chat = agentToolPolicy.selectToolsForSource({ source: AgentRunSource.CHAT, hosted: true, groups: empty })
        expect(agentToolPhases.activeToolsForPhase({ phase: 'discovery', allToolNames: Object.keys(chat) })).not.toContain('ap_build_flow')
        expect(agentToolPhases.activeToolsForPhase({ phase: 'build', allToolNames: Object.keys(chat) })).toContain('ap_build_flow')
        expect(agentToolPolicy.selectToolsForSource({ source: AgentRunSource.AGENT, hosted: true, groups: empty })).not.toHaveProperty('ap_build_flow')
    })
    it('creates directly before any untrusted read and calls the scoped RPC once', async () => {
        const { tools, execute, waitForApproval } = setup()
        await tools.ap_build_flow.execute!({ flowName: 'Lead capture' }, options)
        expect(execute).toHaveBeenCalledExactlyOnceWith('ap_build_flow', { flowName: 'Lead capture' })
        expect(waitForApproval).not.toHaveBeenCalled()
    })
    it('serializes structure read then mutation and requires exact human approval', async () => {
        const { tools, execute, storePendingGate } = setup()
        const read = tools.ap_flow_structure.execute!({ flowId: 'mission' }, options)
        const write = tools.ap_create_table.execute!({ name: 'Leads' }, { ...options, toolCallId: 'second' })
        await Promise.all([read, write])
        expect(storePendingGate).toHaveBeenCalledWith(expect.objectContaining({ gateId: 'second', toolName: 'ap_create_table', toolInput: { name: 'Leads' } }))
        expect(execute).toHaveBeenLastCalledWith('ap_create_table', { name: 'Leads', approvedGateId: 'second' })
    })
    it('marks updated-record output as untrusted because it can contain existing cells', async () => {
        const { tools, taintState, waitForApproval } = setup()
        await tools.ap_update_record.execute!({ recordId: 'row', fields: { Name: 'Updated' } }, options)
        expect(taintState.tainted).toBe(true)
        await tools.ap_create_table.execute!({ name: 'Leads' }, options)
        expect(waitForApproval).toHaveBeenCalledTimes(1)
    })
    it('does not write on declined approval or retry an uncertain mutation', async () => {
        const { tools, execute, taintState } = setup(false)
        taintState.tainted = true
        await tools.ap_create_table.execute!({ name: 'Denied' }, options)
        expect(execute).not.toHaveBeenCalled()
        taintState.tainted = false
        execute.mockRejectedValueOnce(new Error('connection lost'))
        await expect(tools.ap_build_flow.execute!({ flowName: 'Uncertain' }, options)).rejects.toThrow('connection lost')
        expect(execute).toHaveBeenCalledTimes(1)
    })
})


describe('hosted builder Gadget aliases', () => {
    it('brands discovery and binds approval to the exact canonical request', async () => {
        const original = '@activepieces/piece-forms'
        const branded = '@sydekyks/piece-forms'
        const execute = vi.fn(async (name: string) => name === 'ap_research_pieces'
            ? { content: [{ type: 'text', text: JSON.stringify({ pieces: [{ name: original }] }) }] }
            : { content: [{ type: 'text', text: 'saved' }] })
        const storePendingGate = vi.fn(async () => undefined)
        const taintState = { tainted: true }
        const tools = await withGadgetIdentifiers(createHostedBuilderTools({
            definitions: [
                { name: 'ap_research_pieces', description: `Find ${original}`, inputSchema: { type: 'object', properties: { pieceNames: { type: 'array', items: { type: 'string' } } } }, readOnly: true },
                { name: 'ap_update_trigger', description: `Configure ${original}`, inputSchema: { type: 'object', properties: { pieceName: { type: 'string' }, input: { type: 'object' } } }, readOnly: false },
            ],
            execute, taintState, storePendingGate,
            eventEmitter: { emitActionPreview: vi.fn() } as never,
            waitForApproval: async () => ({ outcome: 'approved' }),
        }))
        const discovery = await tools.ap_research_pieces.execute!({ pieceNames: [branded] }, options)
        expect(JSON.stringify(discovery)).toContain(branded)
        expect(JSON.stringify(discovery)).not.toContain(original)
        expect(execute).toHaveBeenCalledWith('ap_research_pieces', { pieceNames: [original] })
        const data = { literal: branded }
        await tools.ap_update_trigger.execute!({ pieceName: branded, input: data }, options)
        expect(storePendingGate).toHaveBeenCalledWith(expect.objectContaining({
            toolName: 'ap_update_trigger', toolInput: { pieceName: original, input: data },
        }))
        expect(execute).toHaveBeenLastCalledWith('ap_update_trigger', { pieceName: original, input: data, approvedGateId: options.toolCallId })
    })
})
