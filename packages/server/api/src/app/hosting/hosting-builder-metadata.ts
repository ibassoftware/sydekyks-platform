import { McpToolResult } from '@activepieces/shared'

const METADATA_BYTES = 6 * 1024
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown, limit = 160): string | undefined {
    return typeof value === 'string' ? value.replace(/\bActivepieces\b/g, 'Sydekyks').slice(0, limit) : undefined
}
function compactProp(value: unknown): Record<string, unknown> {
    const prop = record(value)
    const result: Record<string, unknown> = { name: prop.name, type: prop.type, required: prop.required === true }
    if (prop.description) result.description = text(prop.description)
    if (prop.defaultValue !== undefined) {
        if (Buffer.byteLength(JSON.stringify(prop.defaultValue)) <= 512) result.defaultValue = prop.defaultValue
        else result.defaultValueOmitted = true
    }
    if (Array.isArray(prop.options)) {
        // Retain actual option values; labels are explanatory metadata only.
        result.options = prop.options.slice(0, 30).map(value => { const option = record(value); return { label: text(option.label, 80), value: option.value } })
        if (prop.options.length > 30) result.optionsTruncated = true
    }
    if (Array.isArray(prop.items)) result.items = prop.items.map(compactProp)
    if (Array.isArray(prop.dynamicFields)) result.dynamicFields = prop.dynamicFields.map(compactProp)
    if (['DYNAMIC', 'DROPDOWN', 'MULTI_SELECT_DROPDOWN'].includes(String(prop.type))) result.configuration = 'Dynamic options are not resolved here; use exact known IDs or configure in the Mission editor.'
    return result
}
function compactComponent(value: unknown): Record<string, unknown> {
    const component = record(value)
    return { name: component.name, displayName: text(component.displayName, 100), description: text(component.description, 140), requiresAuth: component.requiresAuth }
}

// These are catalogue/tool-result summaries only. User messages, conversation
// history and executable tool input schemas are never rewritten here.
export function hostedBuilderMetadata(toolName: string, result: McpToolResult): McpToolResult {
    if (result.isError || !result.structuredContent) return result
    const source = result.structuredContent
    let summary: Record<string, unknown>
    if (toolName === 'ap_get_piece_props') {
        summary = {
            piece: source.piece, name: source.name, description: text(source.description, 220),
            requiresAuth: source.requiresAuth,
            props: Array.isArray(source.props) ? source.props.map(compactProp) : [],
            requiredInputs: source.requiredInputs,
            outputFields: source.outputFields,
            outputFieldsSource: source.outputFieldsSource,
            ...(source.wholeOutput ? { wholeOutput: text(source.wholeOutput, 320) } : {}),
            staticSchemaOnly: true,
        }
    }
    else if (toolName === 'ap_research_pieces') {
        summary = {
            pieces: Array.isArray(source.pieces) ? source.pieces.map(value => {
                const piece = record(value)
                return { name: piece.name, displayName: text(piece.displayName, 100), description: text(piece.description, 160),
                    ...(Array.isArray(piece.actions) ? { actions: piece.actions.map(compactComponent) } : {}),
                    ...(Array.isArray(piece.triggers) ? { triggers: piece.triggers.map(compactComponent) } : {}),
                    ...(piece.recommendedActions ? { recommendedActions: piece.recommendedActions } : {}),
                    ...(piece.actionCount !== undefined ? { actionCount: piece.actionCount } : {}),
                    ...(piece.triggerCount !== undefined ? { triggerCount: piece.triggerCount } : {}),
                }
            }) : [],
            missing: source.missing, count: source.count, totalCount: source.totalCount,
            ...(source.trimmed ? { trimmed: true } : {}),
        }
    }
    else return result
    const encoded = JSON.stringify(summary)
    const compact: McpToolResult = { content: [{ type: 'text', text: encoded }] }
    if (Buffer.byteLength(JSON.stringify(compact)) > METADATA_BYTES) return {
        isError: true,
        content: [{ type: 'text', text: 'This catalogue metadata exceeds the safe result size. No schema was returned. Request one Gadget/action at a time or use its Mission editor. Do not assume missing fields are optional.' }],
    }
    // A single representation avoids paying for the same metadata twice in
    // content and structuredContent on every subsequent reasoning step.
    return compact
}
