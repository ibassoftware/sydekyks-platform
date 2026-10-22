import { AgentConfigResponse } from '@activepieces/shared'
import { jsonSchema, tool, ToolSet } from 'ai'
import { AgentEventEmitter, GateDecision } from './tools/tool-primitives'

export function createHostedBuilderTools({ definitions = [], execute, taintState, eventEmitter, waitForApproval, storePendingGate }: {
    definitions: AgentConfigResponse['hostedBuilderTools']
    execute: (name: string, input: Record<string, unknown>) => Promise<unknown>
    taintState: { tainted: boolean }
    eventEmitter: AgentEventEmitter
    waitForApproval: (input: { gateId: string }) => Promise<GateDecision>
    storePendingGate: (input: { gateId: string, toolName: string, displayName: string, toolInput: Record<string, unknown> }) => Promise<void>
}): ToolSet {
    // Preserve order for reads followed by mutations in one model step. Never
    // retry an uncertain mutation: callers must inspect its result first.
    let tail: Promise<unknown> = Promise.resolve()
    return Object.fromEntries(definitions.map(definition => [definition.name, tool({
        description: definition.description,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
        execute: async (input, options) => {
            const invoke = async () => {
                let requested = input
                if (!definition.readOnly && taintState.tainted) {
                    const gateId = options.toolCallId
                    const label = 'Confirm this change to your Mission or Table'
                    eventEmitter.emitActionPreview({ toolCallId: gateId, pieceName: '', actionName: definition.name, actionDisplayName: label, input, isBatch: false })
                    await storePendingGate({ gateId, toolName: definition.name, displayName: label, toolInput: input })
                    const decision = await waitForApproval({ gateId })
                    if (decision.outcome !== 'approved') return { isError: true, content: [{ type: 'text', text: 'Change was not approved. Do not retry it.' }] }
                    requested = { ...input, approvedGateId: gateId }
                }
                const result = await execute(definition.name, requested)
                if ((definition.readOnly || definition.name === 'ap_update_record') && !['ap_research_pieces', 'ap_get_piece_props'].includes(definition.name)) taintState.tainted = true
                return result
            }
            const pending = tail.then(invoke)
            tail = pending.catch(() => undefined)
            return pending
        },
    })]))
}
