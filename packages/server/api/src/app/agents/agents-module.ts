import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { sydAgentRunController } from '../syd/copilot/agent-run-controller'
import { agentToolsController } from './agent-tools-controller'

export const agentsModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(agentToolsController, { prefix: '/v1/projects/:projectId/agent-tools' })
    await app.register(sydAgentRunController, { prefix: '/v1/agents' })
}
