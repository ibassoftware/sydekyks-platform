import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { sydConversationController } from './conversation-controller'
import { sydCopilotAvailability } from './copilot-availability'
import { sydPersonalizationController } from './personalization/personalization-controller'

export const sydCopilotModule: FastifyPluginAsyncZod = async (app) => {
    app.addHook('preHandler', sydCopilotAvailability.chatVisibilityGuard)
    await app.register(sydConversationController.register, { prefix: '/v1/syd/copilot' })
    await app.register(sydPersonalizationController.register, { prefix: '/v1/syd/copilot/personalization' })
}
