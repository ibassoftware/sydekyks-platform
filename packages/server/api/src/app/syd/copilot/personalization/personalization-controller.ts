import { PrincipalType, UpsertChatPersonalizationRequest } from '@activepieces/shared'
import { FastifyReply, FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { sydPersonalizationService } from './personalization-service'

const handlers = {
    getPersonalization: async ({ request }: { request: FastifyRequest }) => sydPersonalizationService(request.log).getEffectiveView({ platformId: request.principal.platform.id, userId: request.principal.id }),
    upsertPersonalization: async ({ request, reply }: { request: Pick<FastifyRequest, 'log' | 'principal'> & { body: UpsertChatPersonalizationRequest }, reply: FastifyReply }) => reply.code(202).send(await sydPersonalizationService(request.log).upsert({ platformId: request.principal.platform.id, userId: request.principal.id, ...request.body })),
}

const register: FastifyPluginAsyncZod = async (app) => {
    app.get('/', CONFIG, async (request) => handlers.getPersonalization({ request }))
    app.post('/', { ...CONFIG, schema: { body: UpsertChatPersonalizationRequest } }, async (request, reply) => handlers.upsertPersonalization({ request, reply }))
}

const PRINCIPALS: readonly PrincipalType.USER[] = [PrincipalType.USER]
const CONFIG = { config: { security: securityAccess.publicPlatform(PRINCIPALS) } }

export const sydPersonalizationController = { register, handlers }
