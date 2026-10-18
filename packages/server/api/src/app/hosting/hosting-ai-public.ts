import { createHash } from 'node:crypto'
import { HOSTED_MANAGED_MODEL } from './hosting-ai-policy'

type PublicCall = { id: string, payer: 'managed' | 'byok' }

// Provider-owned IDs can contain supplier/model names. Replace them at the
// boundary, while preserving deterministic IDs for replay and tool history.
export function hostedPublicResponse(response: Record<string, unknown>, call: PublicCall): Record<string, unknown> {
    if (call.payer !== 'managed') return response
    const value = structuredClone(response)
    value.id = `sydekyks-${call.id}`
    value.model = HOSTED_MANAGED_MODEL
    type ToolIds = { tool_calls?: { id?: string, index?: number }[] }
    const choices = value.choices as { message?: ToolIds, delta?: ToolIds }[] | undefined
    for (const [choiceIndex, choice] of (choices ?? []).entries()) {
        for (const [toolIndex, tool] of (choice.message?.tool_calls ?? choice.delta?.tool_calls ?? []).entries()) {
            if (typeof tool.id !== 'string') continue
            const digest = createHash('sha256').update(JSON.stringify([call.id, choiceIndex, tool.index ?? toolIndex])).digest('hex').slice(0, 32)
            tool.id = `sydekyks-tool-${digest}`
        }
    }
    return value
}

export function hostedPublicChunk(text: string, call: PublicCall): string {
    if (call.payer !== 'managed' || text.trim() === 'data: [DONE]') return text
    return `data: ${JSON.stringify(hostedPublicResponse(JSON.parse(text.slice(6).trim()), call))}\n\n`
}
