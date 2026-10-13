import { Agent, ApplicationEventName } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { applicationEvents } from '../../helper/application-events'
import { sydChatAgentAdministrationSupport } from './tools/chat-agent-administration'

function changed({ request, agent, action }: { request: FastifyRequest, agent: Agent, action: AgentChangeEvent }): void {
    applicationEvents(request.log).sendUserEvent(request, { action, data: { agent: { id: agent.id, displayName: agent.displayName } } })
}
function published({ request, agent }: { request: FastifyRequest, agent: Agent }): void {
    applicationEvents(request.log).sendUserEvent(request, { action: ApplicationEventName.AGENT_PUBLISHED, data: { agent: { id: agent.id, displayName: agent.displayName, ...sydChatAgentAdministrationSupport.describePublished({ published: agent.draft }) } } })
}

export const sydAgentSideEffects = { changed, published }
type AgentChangeEvent = ApplicationEventName.AGENT_CREATED | ApplicationEventName.AGENT_UPDATED | ApplicationEventName.AGENT_UNPUBLISHED | ApplicationEventName.AGENT_DELETED
