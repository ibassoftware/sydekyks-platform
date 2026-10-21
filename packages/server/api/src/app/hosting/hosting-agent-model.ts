import { createHash } from 'node:crypto'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { HOSTED_AI_MAX_OUTPUT, HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL, HostedAiRequest } from './hosting-ai-policy'
import { hostedCopilotPayer, hostedCopilotScope } from './hosting-copilot'
import { hostingServices } from './hosting-services'
import { hostingFail } from './hosting-transactions'

// Tool planners use the same admitted execution and single Credits ledger as
// the Agent turn. No supplier credentials enter the planner or worker payload.
export async function hostedAgentToolModel(input: { admissionId?: string, requestKey?: string, toolName: string }) {
    if (!input.requestKey || input.requestKey.length > 256) hostingFail('HOSTING_TOOL_IDEMPOTENCY_REQUIRED')
    const { segment, data } = await hostedCopilotScope({ admissionId: input.admissionId, spending: true })
    const payer = await hostedCopilotPayer({ platformId: segment.platformId, projectId: segment.projectId, provider: data.provider, configId: data.providerConfigId })
    const model = payer.type === 'byok' ? HOSTED_DEEPSEEK_MODEL : HOSTED_MANAGED_MODEL
    return createOpenAICompatible({ name: 'sydekyks', baseURL: 'https://sydekyks.invalid', fetch: async (_url, init) => {
        if (typeof init?.body !== 'string') hostingFail('HOSTING_AI_REQUEST_INVALID')
        const { messages, max_tokens, temperature, response_format, tools, tool_choice, stream } = JSON.parse(init.body)
        if (stream) hostingFail('HOSTING_AI_REQUEST_INVALID')
        const body = { model, messages, max_tokens: Math.min(max_tokens ?? 1024, HOSTED_AI_MAX_OUTPUT), temperature, response_format, tools, tool_choice }
        const callKey = `tool:${createHash('sha256').update(JSON.stringify({ key: input.requestKey, tool: input.toolName, body })).digest('hex')}`
        const response = await hostingServices.gateway().execute({ scope: { admissionId: segment.admissionId!, platformId: segment.platformId, projectId: segment.projectId }, request: HostedAiRequest.parse({ ...body, payer, callKey, attempt: 0 }), signal: init?.signal ?? undefined })
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
    } }).chatModel(model)
}
