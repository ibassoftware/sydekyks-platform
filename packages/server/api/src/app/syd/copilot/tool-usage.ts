import { AgentConversation, AgentRunSource, chatBilling, ChatToolCall, isAppSumoCreditedPlan, PersistedAgentMessage, PersistedAgentPartType, PersistedAgentRole, PersistedToolCallStatus } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { LicenseKeyPostHogEvents } from '../../helper/telemetry.utils'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { trackBillingAndSendTelemetry } from '../../platform/billing-and-telemetry'
import { CreditUsageSource, TrackCreditsParams } from '../../platform/billing-provider'
import { platformService } from '../../platform/platform.service'
import { sydAgentRuntime } from './agent-runtime'
import { sydChatModelSelection } from './chat-model-selection'
import { sydCopilotContext } from './copilot-context'
import { sydConversationHistory } from './history/conversation-history'

function latestTurnToolCalls({ messages }: { messages: PersistedAgentMessage[] }): ChatToolCall[] {
    let start = 0
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === PersistedAgentRole.USER) {
            start = index + 1; break
        }
    }
    return messages.slice(start).flatMap((message) => message.parts.flatMap((part) => part.type === PersistedAgentPartType.TOOL_CALL && part.status === PersistedToolCallStatus.COMPLETED ? [{ toolName: part.toolName, output: part.output }] : []))
}

function countBillableToolCallsInLatestTurn({ messages }: { messages: PersistedAgentMessage[] }): number {
    return latestTurnToolCalls({ messages }).filter((call) => chatBilling.isFlatBilledToolCall(call)).length
}

async function chargeForLatestTurn({ conversation, runId, log }: ChargeForLatestTurnParams): Promise<void> {
    // Hosted turns settle each provider call through the durable credit ledger.
    if (hostingConfiguration.getServiceMode() === 'hosted') return
    const messages = sydConversationHistory.resolveMessages({ conversation, log })
    const turnIndex = messages.filter((message) => message.role === PersistedAgentRole.USER).length
    const configured = conversation.source === AgentRunSource.CHAT || conversation.source === AgentRunSource.AGENT_BUILDER ? null : await sydAgentRuntime.snapshot({ conversationId: conversation.id, runId })
    const provider = configured?.config.provider ?? await sydCopilotContext.resolveChatProviderName({ platformId: conversation.platformId, projectId: conversation.projectId ?? null, log })
    const surface = configured ? 'flow' : 'chat'
    const model = sydChatModelSelection.resolveModelIdForAnalytics({ provider, selectedModel: conversation.modelName ?? null, surface })
    const tier = sydChatModelSelection.resolveTier({ tierId: conversation.modelName ?? null, surface })
    const { plan } = await platformService(log).getOneWithPlanOrThrow(conversation.platformId)
    const credits = chatBilling.creditsForTurn({ provider, toolCalls: latestTurnToolCalls({ messages }) })
    const properties = { platformId: conversation.platformId, projectId: conversation.projectId ?? 'chat', userId: conversation.userId, conversationId: conversation.id, turnIndex, messages: credits.messageCredits, toolCalls: credits.billedToolCalls, provider, model, tier: tier.id }
    const id = runId ?? turnIndex
    const charge: Extract<TrackCreditsParams, { source: CreditUsageSource.CHAT }> | undefined = credits.total ? { platformId: conversation.platformId, value: credits.total, source: CreditUsageSource.CHAT, idempotencyKey: `${conversation.id}:chatTurn:${id}`, properties } : undefined
    await trackBillingAndSendTelemetry({ log, licenseKey: plan?.licenseKey,
        ...(charge ? { credits: charge } : {}),
        ...(charge && plan && isAppSumoCreditedPlan(plan.plan) ? { appSumo: { ...charge, idempotencyKey: `${conversation.id}:appSumoChatTurn:${id}`, properties: { platformId: conversation.platformId, projectId: properties.projectId, conversationId: conversation.id, turnIndex, tier: tier.id } } } : {}),
        telemetry: { event: LicenseKeyPostHogEvents.CHAT_MESSAGE, properties: { provider, model, toolsUsed: credits.billedToolCalls } },
    })
}

export const sydToolUsage = { latestTurnToolCalls, countBillableToolCallsInLatestTurn, chargeForLatestTurn }

export type ChargeForLatestTurnParams = { conversation: AgentConversation, runId?: string, log: FastifyBaseLogger }
