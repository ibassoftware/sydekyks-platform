import { Agent, AgentConfig, AgentTool, AgentToolType, McpAuthType } from '@activepieces/shared'

function redactTools(tools: AgentTool[]): AgentTool[] {
    return tools.map((tool) => {
        if (tool.type !== AgentToolType.MCP) return tool
        switch (tool.auth.type) {
            case McpAuthType.ACCESS_TOKEN: return { ...tool, auth: { ...tool.auth, accessToken: '' } }
            case McpAuthType.API_KEY: return { ...tool, auth: { ...tool.auth, apiKey: '' } }
            case McpAuthType.HEADERS: return { ...tool, auth: { ...tool.auth, headers: Object.fromEntries(Object.keys(tool.auth.headers).map((key) => [key, ''])) } }
            case McpAuthType.NONE: return tool
        }
    })
}

function promptTools(tools: AgentTool[]): AgentTool[] {
    return redactTools(tools).map((tool) => tool.type === AgentToolType.PIECE ? { ...tool, pieceMetadata: { ...tool.pieceMetadata, ...(tool.pieceMetadata.predefinedInput ? { predefinedInput: { fields: Object.fromEntries(Object.entries(tool.pieceMetadata.predefinedInput.fields).map(([name, field]) => [name, { mode: field.mode, value: '[configured value]' }])) } } : {}) } } : tool)
}

function redact(agent: Agent): Agent {
    return { ...agent, draft: { ...agent.draft, tools: redactTools(agent.draft.tools) }, published: agent.published ? { ...agent.published, tools: redactTools(agent.published.tools) } : null }
}

function restoreDraft({ incoming, stored }: { incoming: AgentConfig, stored: AgentConfig }): AgentConfig {
    return { ...incoming, tools: incoming.tools.map((tool) => {
        if (tool.type !== AgentToolType.MCP) return tool
        const old = stored.tools.find((candidate) => candidate.toolName === tool.toolName && candidate.type === AgentToolType.MCP && candidate.serverUrl === tool.serverUrl)
        if (!old || old.type !== AgentToolType.MCP) return tool
        const auth = tool.auth
        const prior = old.auth
        if (auth.type === McpAuthType.ACCESS_TOKEN && prior.type === McpAuthType.ACCESS_TOKEN) return { ...tool, auth: { ...auth, accessToken: auth.accessToken || prior.accessToken } }
        if (auth.type === McpAuthType.API_KEY && prior.type === McpAuthType.API_KEY && auth.apiKeyHeader === prior.apiKeyHeader) return { ...tool, auth: { ...auth, apiKey: auth.apiKey || prior.apiKey } }
        if (auth.type === McpAuthType.HEADERS && prior.type === McpAuthType.HEADERS) return { ...tool, auth: { ...auth, headers: Object.fromEntries(Object.entries(auth.headers).map(([key, value]) => [key, value || prior.headers[key] || ''])) } }
        return tool
    }) }
}

export const sydAgentSecrets = { redact, redactTools, promptTools, restoreDraft }
