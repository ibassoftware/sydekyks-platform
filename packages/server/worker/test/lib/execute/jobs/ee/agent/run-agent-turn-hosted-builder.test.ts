import { AIProviderName } from '@activepieces/core-utils'
import { agentAiUtils } from '@activepieces/server-utils'
import { AgentRunSource } from '@activepieces/shared'
import { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { ModelMessage } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentToolPolicy } from '../../../../../../src/lib/execute/jobs/ee/agent/agent-tool-policy'
import { createHostedBuilderTools } from '../../../../../../src/lib/execute/jobs/ee/agent/hosted-builder-tools'
import { runAgentTurn } from '../../../../../../src/lib/execute/jobs/ee/agent/run-agent-turn'
import { createPhaseTools } from '../../../../../../src/lib/execute/jobs/ee/agent/tools/session-tools'

const NAMES = [
    'ap_build_flow', 'ap_create_flow', 'ap_create_folder', 'ap_list_flows', 'ap_list_folders',
    'ap_flow_structure', 'ap_read_step_settings', 'ap_rename_flow', 'ap_update_trigger',
    'ap_add_step', 'ap_update_step', 'ap_validate_flow', 'ap_research_pieces', 'ap_get_piece_props',
    'ap_list_connections', 'ap_create_table', 'ap_list_tables', 'ap_find_records', 'ap_insert_records', 'ap_update_record',
]
const READS = new Set(['ap_list_flows', 'ap_list_folders', 'ap_flow_structure', 'ap_read_step_settings', 'ap_validate_flow', 'ap_research_pieces', 'ap_get_piece_props', 'ap_list_connections', 'ap_list_tables', 'ap_find_records'])
const definitions = NAMES.map(name => ({ name, description: `Scoped draft tool ${name}`, readOnly: READS.has(name), inputSchema: { type: 'object', additionalProperties: true } }))
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const tier = { id: 'smart', modelId: 'hosted-test-model', thinkingBudget: 0 }
const finish = (reason: 'tool-calls' | 'stop'): LanguageModelV4StreamPart => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } })
const call = (name: string, input: Record<string, unknown>, id: string): LanguageModelV4StreamPart[] => [{ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) }, finish('tool-calls')]
const reply: LanguageModelV4StreamPart[] = [{ type: 'text-start', id: 'done' }, { type: 'text-delta', id: 'done', delta: 'Saved the Mission draft.' }, { type: 'text-end', id: 'done' }, finish('stop')]

function surface(execute: (name: string, input: Record<string, unknown>) => Promise<unknown>, carriedRead = false, approved = true) {
    const waitForApproval = vi.fn(async () => ({ outcome: approved ? 'approved' : 'declined' } as never))
    const storePendingGate = vi.fn(async () => undefined)
    const bridge = createHostedBuilderTools({ definitions, execute, taintState: { tainted: carriedRead }, eventEmitter: { emitActionPreview: vi.fn() } as never, waitForApproval, storePendingGate })
    const tools = agentToolPolicy.selectToolsForSource({ source: AgentRunSource.CHAT, hosted: true, groups: { local: {}, display: {}, crossProject: {}, web: {}, thinking: {}, phase: {}, buildPlan: {}, email: {}, agentSurface: {}, mcp: bridge, configuredPiece: {}, configuredFlow: {}, knowledgeBase: {}, completion: {} } })
    return { tools, waitForApproval, storePendingGate }
}

async function turn(model: MockLanguageModelV4, tools: ReturnType<typeof surface>['tools'], messages: ModelMessage[], hosted = true) {
    return runAgentTurn({
        hosted, model, provider: AIProviderName.OPENAI, modelId: tier.modelId, tier,
        systemPrompt: 'Build and edit only the admitted saved Mission draft. Do not publish or run it.',
        messages, tools, allToolNames: Object.keys(tools), phaseState: { phase: 'discovery' },
        abortSignal: new AbortController().signal, log,
        sinks: { drainStream: async result => {
            await result.consumeStream()
            return undefined
        } },
    })
}

afterEach(() => vi.restoreAllMocks())

describe('hosted builder tools at the model boundary', () => {
    it('creates seven steps and edits the existing draft on a new discovery turn with 42 earlier messages', async () => {
        const steps: Array<{ name: string, displayName: string }> = []
        const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
            if (name === 'ap_build_flow') {
                steps.push({ name: 'trigger', displayName: 'Webhook' }, { name: 'step_1', displayName: 'Ask AI' })
                return { flowId: 'saved-mission', valid: true }
            }
            if (name === 'ap_add_step') {
                expect(input.flowId).toBe('saved-mission')
                steps.push({ name: `step_${steps.length}`, displayName: String(input.displayName) })
                return { stepName: steps.at(-1)!.name, valid: true }
            }
            if (name === 'ap_update_step') {
                expect(input.approvedGateId).toBe('edit-existing')
                const target = steps.find(step => step.name === input.stepName)!
                target.displayName = String(input.displayName)
                return { saved: true, valid: true }
            }
            return { flowId: 'saved-mission', steps, valid: steps.length === 7 }
        })
        const build = surface(execute)
        const plan = [
            ['ap_build_flow', { flowName: 'Seven-step lead capture', trigger: { pieceName: '@activepieces/piece-webhook', triggerName: 'catch_webhook' }, steps: [{ type: 'PIECE', displayName: 'Ask AI' }] }],
            ...['Normalize name', 'Calculate estimate', 'Map lead fields', 'Insert lead in Table', 'Return response'].map((displayName, i) => ['ap_add_step', { flowId: 'saved-mission', parentStepName: `step_${i + 1}`, stepLocationRelativeToParent: 'AFTER', stepType: 'PIECE', displayName }]),
            ['ap_validate_flow', { flowId: 'saved-mission' }],
        ] as Array<[string, Record<string, unknown>]>
        let index = 0
        const model = new MockLanguageModelV4({ doStream: async options => {
            // This is the actual tool schema list received by the AI SDK provider,
            // not merely a registry/listTools assertion. No phase helper is used.
            expect(options.tools?.map(tool => tool.name).sort()).toEqual([...NAMES].sort())
            const action = plan[index++]
            return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...(action ? call(action[0], action[1], `build-${index}`) : reply)]) }
        } })
        const built = await turn(model, build.tools, [{ role: 'user', content: 'Create this seven-step lead capture Mission as an unpublished draft.' }])
        expect(built.streamError).toBeNull()
        expect(steps).toHaveLength(7)
        expect(execute.mock.calls.filter(([name]) => name === 'ap_build_flow')).toHaveLength(1)
        expect(execute.mock.calls.filter(([name]) => name === 'ap_add_step')).toHaveLength(5)
        expect(build.waitForApproval).not.toHaveBeenCalled()

        const earlier: ModelMessage[] = Array.from({ length: 21 }, (_, i) => [
            { role: 'user', content: `Earlier build detail ${i + 1}.` } as ModelMessage,
            { role: 'assistant', content: `Saved planning detail ${i + 1}.` } as ModelMessage,
        ]).flat()
        expect(earlier).toHaveLength(42)
        // A carried read requires exact approval even though editing tools are now
        // visible immediately. Visibility never bypasses the existing write gate.
        const edit = surface(execute, true)
        let editStep = 0
        const followup = new MockLanguageModelV4({ doStream: async options => {
            expect(options.tools?.some(tool => tool.name === 'ap_update_step')).toBe(true)
            const parts = editStep++ === 0
                ? call('ap_flow_structure', { flowId: 'saved-mission' }, 'read-existing')
                : editStep === 2 ? call('ap_update_step', { flowId: 'saved-mission', stepName: 'step_5', displayName: 'Save qualified lead' }, 'edit-existing') : reply
            return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...parts]) }
        } })
        const edited = await turn(followup, edit.tools, [...earlier, ...built.accumulatedResponseMessages, { role: 'user', content: 'Rename the existing Table insertion step to Save qualified lead. Keep the same Mission.' }])
        expect(edited.streamError).toBeNull()
        expect(steps).toHaveLength(7)
        expect(steps.find(step => step.name === 'step_5')?.displayName).toBe('Save qualified lead')
        expect(execute.mock.calls.filter(([name]) => name === 'ap_build_flow')).toHaveLength(1)
        expect(edit.waitForApproval).toHaveBeenCalledExactlyOnceWith({ gateId: 'edit-existing' })
        expect(edit.storePendingGate).toHaveBeenCalledWith(expect.objectContaining({ gateId: 'edit-existing', toolName: 'ap_update_step' }))
        expect(execute.mock.calls.some(([name]) => /publish|test_flow|execute_action/.test(name))).toBe(false)
    })

    it('completes 40 model steps without an implicit supplier-call ceiling', async () => {
        const execute = vi.fn(async (_name: string, input: Record<string, unknown>) => ({ pieces: [], query: input.query }))
        let step = 0
        const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            ...(step++ < 39 ? call('ap_research_pieces', { query: `Synthetic research ${step}` }, `funded-${step}`) : reply),
        ]) }) })
        const result = await turn(model, surface(execute).tools, [{ role: 'user', content: 'Research the supplied 39 distinct requests, then finish.' }])
        expect(result.streamError).toBeNull()
        expect(result.truncatedAfterRetries).toBe(false)
        expect(result.budgetExceeded).toBe(false)
        expect(result.creditsExhausted).toBe(false)
        expect(model.doStreamCalls).toHaveLength(40)
        expect(execute).toHaveBeenCalledTimes(39)
    })

    it('sends all earlier hosted tool results intact instead of applying self-hosted heuristic compaction', async () => {
        const history: ModelMessage[] = [{ role: 'user', content: 'Preserve all original customer instructions and tool details.' }]
        const values = Array.from({ length: 12 }, (_, index) => `unique-result-${index}:` + 'exact previous saved data '.repeat(1200))
        for (const [index, value] of values.entries()) {
            history.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `prior-${index}`, toolName: 'ap_flow_structure', input: { flowId: 'same-mission' } }] })
            history.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `prior-${index}`, toolName: 'ap_flow_structure', output: { type: 'text', value } }] })
        }
        history.push({ role: 'user', content: 'Now make the third requested edit to that same Mission.' })
        const saved = JSON.stringify(history)
        const model = new MockLanguageModelV4({ doStream: async options => {
            const prompt = JSON.stringify(options.prompt)
            for (const value of values) expect(prompt).toContain(value)
            expect(prompt).toContain('Preserve all original customer instructions')
            expect(prompt).not.toContain('result omitted to save context')
            return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...reply]) }
        } })
        await turn(model, surface(vi.fn(async () => ({}))).tools, history)
        expect(JSON.stringify(history)).toBe(saved)
    })

    it('still blocks a follow-up edit when its exact approval is declined', async () => {
        const execute = vi.fn(async () => ({ saved: true }))
        const edit = surface(execute, true, false)
        let step = 0
        const model = new MockLanguageModelV4({ doStream: async options => {
            expect(options.tools?.some(tool => tool.name === 'ap_update_step')).toBe(true)
            return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...(step++ === 0 ? call('ap_update_step', { flowId: 'saved-mission', stepName: 'step_5', displayName: 'Declined' }, 'denied-edit') : reply)]) }
        } })
        await turn(model, edit.tools, [{ role: 'user', content: 'Rename this saved step.' }])
        expect(edit.waitForApproval).toHaveBeenCalledOnce()
        expect(execute).not.toHaveBeenCalled()
    })

    it('describes phase as progress only for hosted tools and retains the self-hosted unlock guidance', () => {
        const onPhaseChange = vi.fn()
        const hosted = createPhaseTools({ toolsAlreadyVisible: true, onPhaseChange })
        expect(hosted.ap_set_phase.description).toContain('All supplied tools are already available')
        expect(hosted.ap_set_phase.description).not.toContain('unlock')
        expect(createPhaseTools({ onPhaseChange }).ap_set_phase.description).toContain('This unlocks the build/execution tools')
    })

    it('keeps self-hosted discovery filtering unchanged', async () => {
        vi.spyOn(agentAiUtils, 'affordableOutputTokens').mockResolvedValue(4096)
        const execute = vi.fn(async () => ({ saved: true }))
        const build = surface(execute)
        const model = new MockLanguageModelV4({ doStream: async options => {
            const names = options.tools?.map(tool => tool.name)
            expect(names).toContain('ap_flow_structure')
            expect(names).not.toContain('ap_add_step')
            expect(names).not.toContain('ap_update_step')
            expect(names).not.toContain('ap_build_flow')
            return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...reply]) }
        } })
        await turn(model, build.tools, [{ role: 'user', content: 'Explain this Mission.' }], false)
        expect(execute).not.toHaveBeenCalled()
    })
})
