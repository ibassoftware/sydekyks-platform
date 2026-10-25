import { internalGadgetName, publicGadgetName } from '@activepieces/core-utils'
import { asSchema, ModelMessage, tool, ToolExecutionOptions } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { internalGadgetInput, publicGadgetHistory, publicGadgetMetadata, publicGadgetResult, withGadgetIdentifiers } from '../../../../../../src/lib/execute/jobs/ee/agent/tools/gadget-identifiers'

const original = '@activepieces/piece-forms'
const branded = '@sydekyks/piece-forms'
const options: ToolExecutionOptions<undefined> = { toolCallId: 'call', messages: [] }

describe('Copilot Gadget namespace boundary', () => {
    it('preserves legacy and third-party identifiers and resolves the public alias', () => {
        expect(internalGadgetName(branded)).toBe(original)
        expect(internalGadgetName(original)).toBe(original)
        expect(publicGadgetName(original)).toBe(branded)
        expect(internalGadgetName('@customer/piece-forms')).toBe('@customer/piece-forms')
        expect(publicGadgetName('@activepieces/pieces-framework')).toBe('@activepieces/pieces-framework')
    })

    it('translates nested workflow and agent identities without modifying customer inputs or code', () => {
        const data = { pieceName: branded, text: branded }
        const source = { trigger: { pieceName: branded, input: data }, steps: [{ settings: { pieceName: branded, input: data, sourceCode: branded } }], draft: { tools: [{ pieceMetadata: { pieceName: branded, predefinedInput: { fields: data } } }] } }
        const snapshot = JSON.stringify(source)
        expect(internalGadgetInput(source)).toEqual({ trigger: { pieceName: original, input: data }, steps: [{ settings: { pieceName: original, input: data, sourceCode: branded } }], draft: { tools: [{ pieceMetadata: { pieceName: original, predefinedInput: { fields: data } } }] } })
        expect(JSON.stringify(source)).toBe(snapshot)
    })

    it('brands discovery JSON, textual results and existing workflow settings together', () => {
        const payload = { pieceName: original, description: original }
        const settings = { pieceName: original, input: payload, sourceCode: original }
        const result = publicGadgetResult('ap_read_step_settings', {
            content: [{ type: 'text', text: `Settings:\n${JSON.stringify(settings, null, 2)}\n\nUse ${original}.` }],
            structuredContent: { settings },
        })
        expect(result.structuredContent.settings).toEqual({ ...settings, pieceName: branded })
        expect(result.content[0].text).toContain(`"pieceName":"${branded}"`)
        expect(result.content[0].text).toContain(`"input":${JSON.stringify(payload)}`)
        expect(result.content[0].text).toContain(`"sourceCode":"${original}"`)
        expect(result.content[0].text).toContain(`Use ${branded}.`)
        const discovery = publicGadgetResult('ap_research_pieces', { content: [{ type: 'text', text: `Found:\n${JSON.stringify([{ name: original }])}` }], structuredContent: { pieces: [{ name: original }] } })
        expect(JSON.stringify(discovery)).not.toContain('@activepieces')
    })

    it('brands workflow diagram rows while preserving raw input and source snippets', () => {
        const text = `- [TRIGGER] trigger | PIECE | "Form" (piece: ${original}, trigger: submit)\n  input: {"pieceName":"${original}"}\n  sourceCode: const name = "${original}"`
        const result = publicGadgetResult('ap_flow_structure', { content: [{ type: 'text', text }] })
        const expected = text.replace(`(piece: ${original}`, `(piece: ${branded}`)
        expect(result.content[0].text).toBe(expected)
        expect(publicGadgetResult('ap_flow_structure', text)).toBe(expected)
        expect(publicGadgetResult('ap_flow_structure', [{ type: 'text', text }])).toEqual([{ type: 'text', text: expected }])
    })

    it('never rewrites arbitrary tool output, code or record contents', () => {
        const content = [{ type: 'text', text: JSON.stringify({ pieceName: original, text: original }) }]
        for (const name of ['ap_run_action', 'ap_execute_action', 'ap_run_code', 'ap_read_step_code', 'ap_find_records', 'ap_web_search', 'ap_get_run', 'ap_test_step']) {
            expect(publicGadgetResult(name, { content, _meta: { pieceName: original } })).toEqual({ content, _meta: { pieceName: branded } })
        }
        expect(publicGadgetResult('customer_tool', { pieceName: original })).toEqual({ pieceName: original })
    })

    it('exposes branded schemas while execution and approval comparisons receive canonical inputs', async () => {
        const execute = vi.fn(async input => ({ content: [{ type: 'text', text: `Selected ${input.pieceName}` }], pieceName: input.pieceName }))
        const wrapped = await withGadgetIdentifiers({ ap_update_trigger: tool({
            description: `Configure ${original}`,
            inputSchema: z.object({ pieceName: z.literal(original).describe(`Use ${original}`), input: z.record(z.string(), z.unknown()).optional() }),
            execute,
        }) })
        const definition = wrapped['ap_update_trigger']
        expect(definition.description).toBe(`Configure ${branded}`)
        expect(JSON.stringify(await asSchema(definition.inputSchema).jsonSchema)).toContain(branded)
        expect(JSON.stringify(await asSchema(definition.inputSchema).jsonSchema)).not.toContain(original)
        expect(await asSchema(definition.inputSchema).validate!({ pieceName: branded })).toMatchObject({ success: true, value: { pieceName: branded } })
        const data = { pieceName: branded }
        const result = await definition.execute!({ pieceName: branded, input: data }, options)
        expect(execute).toHaveBeenLastCalledWith({ pieceName: original, input: data }, options)
        expect(result).toMatchObject({ pieceName: branded })
        await definition.execute!({ pieceName: original, input: data }, options)
        expect(execute).toHaveBeenLastCalledWith({ pieceName: original, input: data }, options)
        expect((await asSchema(definition.inputSchema).validate!({})).success).toBe(false)
    })

    it('rebrands old direct and deferred tool history without modifying saved history or user turns', () => {
        const messages: ModelMessage[] = [
            { role: 'user', content: original },
            { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'one', toolName: 'ap_update_trigger', input: { pieceName: original, input: { pieceName: original } } }, { type: 'tool-call', toolCallId: 'two', toolName: 'ap_lazy_tool', input: { tool: 'ap_update_trigger', input: { pieceName: original, input: { pieceName: original } } } }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'one', toolName: 'ap_research_pieces', output: { type: 'json', value: { pieces: [{ name: original }] } } }] },
        ]
        const snapshot = JSON.stringify(messages)
        const mapped = publicGadgetHistory(messages)
        expect(mapped[0]).toBe(messages[0])
        expect(mapped[1]).toMatchObject({ content: [{ input: { pieceName: branded, input: { pieceName: original } } }, { input: { input: { pieceName: branded, input: { pieceName: original } } } }] })
        expect(mapped[2]).toMatchObject({ content: [{ output: { value: { pieces: [{ name: branded }] } } }] })
        expect(JSON.stringify(messages)).toBe(snapshot)
    })

    it('keeps approval payloads and credentials opaque in metadata', () => {
        expect(publicGadgetMetadata({ pieceName: original, input: { pieceName: original }, credentials: { name: original } })).toEqual({ pieceName: branded, input: { pieceName: original }, credentials: { name: original } })
    })
})
