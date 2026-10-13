import { FastifyBaseLogger } from 'fastify'
import { sydAgentConfigRpc } from './rpc/agent-config-rpc'
import { sydConfiguredToolsRpc } from './rpc/configured-tools-rpc'
import { sydConversationRpc } from './rpc/conversation-rpc'
import { sydEmailRpc } from './rpc/email-rpc'

export const sydAgentRpcHandlers = (log: FastifyBaseLogger) => ({ ...sydAgentConfigRpc(log), ...sydConfiguredToolsRpc(log), ...sydConversationRpc(log), ...sydEmailRpc(log) })
