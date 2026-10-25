import { internalGadgetName, publicGadgetName, publicGadgetText } from '@activepieces/core-utils'
import { asSchema, jsonSchema, ModelMessage, ToolSet } from 'ai'

// These fields contain customer data, executable code, or credentials, not Gadget
// identities. Never rewrite their contents, even when a field is named pieceName.
const OPAQUE_FIELDS = new Set(['input', 'output', 'data', 'records', 'rows', 'value', 'sampleData', 'sampleOutput', 'defaultValue', 'exampleInput', 'triggerTestData', 'items', 'logs', 'options', 'sourceCode', 'code', 'packageJson', 'auth', 'credentials', 'predefinedInput'])
const IDENTITY_FIELDS = new Set(['pieceName', 'pieceNames', 'piece', 'toolPieceNames'])
const INPUT_CONTAINERS = new Set(['settings', 'trigger', 'steps', 'children', 'nextAction', 'firstLoopAction', 'branches', 'actions', 'pieceMetadata', 'tools', 'draft', 'published', 'config', 'options', 'choices'])
// Rebrand platform metadata only. Unlisted tools (including customer-defined
// MCP tools) return arbitrary content which must never be rewritten.
const METADATA_TOOLS = new Set([
    'ap_research_pieces', 'ap_search_actions', 'ap_search_triggers', 'ap_get_piece_props',
    'ap_validate_step_config',
    'ap_list_connections', 'ap_setup_guide', 'ap_build_flow', 'ap_create_flow',
    'ap_duplicate_flow', 'ap_list_flows', 'ap_flow_structure', 'ap_read_step_settings',
    'ap_update_trigger', 'ap_add_step', 'ap_update_step', 'ap_validate_flow',
    'ap_discover_action_auth', 'ap_list_across_projects', 'ap_list_agents',
    'ap_create_agent', 'ap_update_agent', 'ap_add_agent_tool', 'ap_remove_agent_tool',
    'ap_get_tool_schema', 'ap_load_skill',
])

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identities(value: unknown, convert: (name: string) => string): unknown {
    if (typeof value === 'string') return convert(value)
    if (Array.isArray(value)) return value.map(item => identities(item, convert))
    return value
}

function gadgetInput<T>(value: T, convert: (name: string) => string): T {
    if (Array.isArray(value)) return value.map(child => gadgetInput(child, convert)) as T
    if (!record(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
        IDENTITY_FIELDS.has(key) ? identities(child, convert)
            : INPUT_CONTAINERS.has(key) ? gadgetInput(child, convert) : child,
    ])) as T
}

export function internalGadgetInput<T>(value: T): T {
    return gadgetInput(value, internalGadgetName)
}

export function publicGadgetMetadata<T>(value: T): T {
    if (Array.isArray(value)) return value.map(publicGadgetMetadata) as T
    if (!record(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
        if (OPAQUE_FIELDS.has(key)) return [key, child]
        if (IDENTITY_FIELDS.has(key) || key === 'name' || key === 'missing') return [key, identities(child, publicGadgetName)]
        if (['hints', 'notes', 'expertNotes'].includes(key)) return [key, identities(child, publicMetadataText)]
        if (typeof child === 'string' && ['text', 'description', 'error', 'message', 'note', 'hint', 'errorSummary', 'authHint'].includes(key)) return [key, publicMetadataText(child)]
        return [key, publicGadgetMetadata(child)]
    })) as T
}

// MCP text often contains a human-readable heading followed by JSON. Parse those
// JSON sections so customer input/output values remain unchanged.
function publicMetadataText(text: string): string {
    let start = -1
    let quoted = false
    let escaped = false
    const stack: string[] = []
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (start < 0) {
            if (char !== '{' && char !== '[') continue
            start = i
        }
        if (quoted) {
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === '"') quoted = false
            continue
        }
        if (char === '"') quoted = true
        else if (char === '{' || char === '[') stack.push(char)
        else if (char === '}' || char === ']') {
            const opener = stack.pop()
            if ((opener === '{' && char !== '}') || (opener === '[' && char !== ']')) break
            if (stack.length === 0) {
                try {
                    const parsed: unknown = JSON.parse(text.slice(start, i + 1))
                    const transformed = publicGadgetMetadata(parsed)
                    // Keep original formatting when the JSON has no metadata to change.
                    const json = JSON.stringify(parsed) === JSON.stringify(transformed) ? text.slice(start, i + 1) : JSON.stringify(transformed)
                    return publicGadgetText(text.slice(0, start)) + json + publicMetadataText(text.slice(i + 1))
                }
                catch {
                    start = -1
                }
            }
        }
    }
    return publicGadgetText(text)
}

export function publicGadgetResult<T>(toolName: string, result: T): T {
    if (!toolName.startsWith('ap_')) return result
    if (toolName === 'ap_flow_structure') {
        if (typeof result === 'string') return publicFlowStructureText(result) as T
        if (Array.isArray(result)) return result.map(publicFlowStructurePart) as T
        if (record(result) && Array.isArray(result['content'])) {
            const { content, ...metadata } = result
            return { ...publicGadgetMetadata(metadata), content: content.map(publicFlowStructurePart) } as T
        }
    }
    if (!METADATA_TOOLS.has(toolName)) {
        if (!record(result) || !('_meta' in result)) return result
        return { ...result, _meta: publicGadgetMetadata(result['_meta']) }
    }
    if (typeof result === 'string') return publicMetadataText(result) as T
    return publicGadgetMetadata(result)
}

function publicFlowStructureText(text: string): string {
    return text.replace(/^(- .*? \(piece: )@activepieces\/piece-/gm, '$1@sydekyks/piece-')
}

function publicFlowStructurePart(part: unknown): unknown {
    return record(part) && typeof part['text'] === 'string' ? { ...part, text: publicFlowStructureText(part['text']) } : part
}

function publicSchema<T>(value: T): T {
    if (typeof value === 'string') return publicGadgetText(value) as T
    if (Array.isArray(value)) return value.map(publicSchema) as T
    if (!record(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, publicSchema(child)])) as T
}

function publicToolDescription(description: ToolSet[string]['description']): ToolSet[string]['description'] {
    if (typeof description === 'function') return options => publicGadgetText(description(options))
    return description === undefined ? undefined : publicGadgetText(description)
}

// Wrap before deferred skills are built so direct calls, ap_get_tool_schema and
// ap_lazy_tool all share the same public contract. Translation happens before
// execution/approval guards; they continue comparing the original internal IDs.
export async function withGadgetIdentifiers(tools: ToolSet): Promise<ToolSet> {
    return Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([name, definition]) => {
        if (!name.startsWith('ap_')) return [name, definition]
        const schema = asSchema(definition.inputSchema)
        const execute = definition.execute
        const validate = schema.validate
        return [name, {
            ...definition,
            description: publicToolDescription(definition.description),
            inputSchema: jsonSchema(publicSchema(await schema.jsonSchema), { validate: validate === undefined ? undefined : async input => {
                const result = await validate(internalGadgetInput(input))
                return result.success ? { ...result, value: gadgetInput(result.value, publicGadgetName) } : result
            } }),
            ...(execute === undefined ? {} : { execute: async (input, options) => publicGadgetResult(name, await execute(internalGadgetInput(input), options)) } satisfies Pick<typeof definition, 'execute'>),
        }]
    })))
}

// Rewrite only model-facing copies of old tool history. User turns, attachments,
// persisted workflow settings and approval records are never migrated in place.
export function publicGadgetHistory(messages: ModelMessage[]): ModelMessage[] {
    const effectiveTools = new Map<string, string>()
    return messages.map(message => {
        if (message.role === 'user' || message.role === 'system' || !Array.isArray(message.content)) return message
        return { ...message, content: message.content.map(part => {
            if (part.type === 'tool-call' && part.toolName.startsWith('ap_')) {
                effectiveTools.set(part.toolCallId, part.toolName === 'ap_lazy_tool' && record(part.input) && typeof part.input['tool'] === 'string' ? part.input['tool'] : part.toolName)
                const input = record(part.input) && part.toolName === 'ap_lazy_tool' ? { ...part.input, input: gadgetInput(part.input['input'], publicGadgetName) } : gadgetInput(part.input, publicGadgetName)
                return { ...part, input }
            }
            if (part.type === 'tool-result') {
                const output = part.output
                if ('value' in output) return { ...part, output: { ...output, value: publicGadgetResult(effectiveTools.get(part.toolCallId) ?? part.toolName, output.value) } }
            }
            return part
        }) } as ModelMessage
    })
}
