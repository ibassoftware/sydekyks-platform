import { AIProviderName } from '@activepieces/core-utils'
import { AiStepAction } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { HOSTED_DEEPSEEK_MODEL, HostedAiRequest } from './hosting-ai-policy'
import { hostingConfiguration } from './hosting-configuration'
import { hostingServices } from './hosting-services'
import { hostingFail } from './hosting-transactions'

const stepSchema = z.strictObject({
    callKey: z.string(), action: z.enum([AiStepAction.ASK_AI, AiStepAction.SUMMARIZE_TEXT, AiStepAction.CLASSIFY_TEXT]),
    provider: z.enum([AIProviderName.ACTIVEPIECES, AIProviderName.DEEPSEEK]), providerConfigId: z.string().optional(), modelId: z.literal(HOSTED_DEEPSEEK_MODEL),
    prompt: z.string().max(32768).optional(), text: z.string().max(32768).optional(), categories: z.array(z.string().min(1).max(256)).min(1).max(100).optional(),
    conversation: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(32768) })).max(32).optional(),
    maxOutputTokens: z.number().int().min(1).max(4096).optional(), temperature: z.number().min(0).max(2).optional(),
    webSearch: z.strictObject({ enabled: z.literal(false), options: z.record(z.string(), z.unknown()).optional() }).optional(),
})
export const hostingAiController: FastifyPluginAsyncZod = async app => {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    const config = { security: securityAccess.engine(), rateLimit: authnRateLimit }
    app.post('/chat/completions', { config, bodyLimit: 65536, schema: { body: HostedAiRequest } }, async request => hostingServices.gateway().execute({ scope: { admissionId: request.principal.id, platformId: request.principal.platform.id, projectId: request.principal.projectId }, request: request.body }))
    app.post('/step', { config, bodyLimit: 65536, schema: { body: stepSchema } }, async request => {
        const input = request.body
        if (input.provider === AIProviderName.DEEPSEEK && !input.providerConfigId) hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
        if (input.provider === AIProviderName.ACTIVEPIECES && input.providerConfigId) hostingFail('HOSTING_AI_PAYER_CONFLICT')
        const prompt = input.action === AiStepAction.SUMMARIZE_TEXT ? `${input.prompt ?? 'Summarize the following text.'}\n${input.text ?? ''}` : input.action === AiStepAction.CLASSIFY_TEXT ? `Return exactly one of these labels: ${JSON.stringify(input.categories ?? [])}\nText: ${input.text ?? ''}` : input.prompt ?? ''
        const messages = [...(input.action === AiStepAction.ASK_AI ? input.conversation ?? [] : []), { role: 'user' as const, content: prompt }]
        const payer = input.provider === AIProviderName.ACTIVEPIECES ? { type: 'managed' as const } : { type: 'byok' as const, configId: input.providerConfigId ?? '' }
        const response = await hostingServices.gateway().execute({ scope: { admissionId: request.principal.id, platformId: request.principal.platform.id, projectId: request.principal.projectId }, request: HostedAiRequest.parse({ callKey: input.callKey, payer, model: input.modelId, messages, max_tokens: input.maxOutputTokens ?? 1024, temperature: input.temperature }) })
        const answer = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).length(1) }).parse(response).choices[0].message.content ?? ''
        if (input.action === AiStepAction.CLASSIFY_TEXT && !input.categories?.includes(answer.trim())) hostingFail('HOSTING_AI_CLASSIFICATION_INVALID')
        return { output: { answer: input.action === AiStepAction.CLASSIFY_TEXT ? answer.trim() : answer, ...(input.action === AiStepAction.ASK_AI && input.conversation ? { conversation: [...messages, { role: 'assistant', content: answer }] } : {}) } }
    })
}
