import { AgentConfigResponse } from '@activepieces/shared'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { tool, ToolSet } from 'ai'
import { z } from 'zod'
import { JobContext } from '../../../types'

export const HOSTED_AGENT_MAX_OUTPUT = 4096

export function createHostedAgentModel({ ctx, config }: { ctx: JobContext, config: NonNullable<AgentConfigResponse['hosted']> }) {
    if (!ctx.admissionId || config.protocol !== 1 || config.model !== 'deepseek-flash') throw new Error('HOSTING_AI_SEGMENT_DENIED')
    let sequence = 0
    return createOpenAICompatible({
        name: 'hosted-deepseek', baseURL: `${ctx.internalApiUrl.replace(/\/$/, '')}/v1/hosting/ai/copilot`, includeUsage: true,
        fetch: async (_url, init) => {
            if (typeof init?.body !== 'string') throw new Error('HOSTING_AI_REQUEST_INVALID')
            const wire = JSON.parse(init.body)
            // SDK/provider options never control the endpoint, payer, retry identity or key.
            const { model, messages, max_tokens, temperature, response_format, tools, tool_choice, stream } = wire
            if (model !== config.model) throw new Error('HOSTING_AI_MODEL_DENIED')
            const payload = { callKey: `copilot:${sequence++}`, attempt: 0, payer: config.payer, model, messages, max_tokens: Math.min(max_tokens ?? 1024, HOSTED_AGENT_MAX_OUTPUT), temperature, response_format, tools: tools?.map((entry: { type: string, function: { name: string, description?: string, parameters?: unknown } }) => ({ type: entry.type, function: { name: entry.function.name, description: entry.function.description, parameters: entry.function.parameters ?? {} } })), tool_choice, stream: stream === true }
            return fetch(`${ctx.internalApiUrl.replace(/\/$/, '')}/v1/hosting/ai/copilot/completions`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.engineToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: init?.signal })
        },
    }).chatModel(config.model)
}

// Local, cost-free tools only. Provider/MCP/piece/nested-flow tools stay unavailable
// until their side effects and spend have inherited admission and accounting.
export function hostedAgentTools(config: AgentConfigResponse): ToolSet {
    return {
        ap_get_workspace_context: tool({ description: 'Read the workspace and model context for this run.', inputSchema: z.object({}), execute: async () => ({ projects: config.projects, model: config.modelId, payer: config.hosted?.payer.type }) }),
        ap_update_thinking_status: tool({ description: 'Describe the next reasoning step.', inputSchema: z.object({ status: z.string().max(256) }), execute: async () => ({ success: true }) }),
    }
}
