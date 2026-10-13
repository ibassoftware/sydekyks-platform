import { FastifyBaseLogger } from 'fastify'
import { sydConversationRpc } from './rpc/conversation-rpc'
import { sydCopilotConfigRpc } from './rpc/copilot-config-rpc'
import { sydEmailRpc } from './rpc/email-rpc'
import { sydToolExecutionRpc } from './rpc/tool-execution-rpc'

export const sydCopilotRpcHandlers = (log: FastifyBaseLogger) => ({
    ...sydCopilotConfigRpc(log), ...sydConversationRpc(log), ...sydEmailRpc(log), ...sydToolExecutionRpc(log),
})
