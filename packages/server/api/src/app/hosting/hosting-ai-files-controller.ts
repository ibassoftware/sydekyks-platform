import { PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { HOSTED_AI_FILE_MAX_BYTES, HOSTED_AI_FILE_MIME_TYPES } from './hosting-ai-file-parser'
import { hostedAiFiles } from './hosting-ai-files'

const Id = z.string().length(21).regex(/^[A-Za-z0-9_-]+$/)
const project = z.object({ projectId: Id }).strict()
export const hostedAiFilesController: FastifyPluginAsyncZod = async app => {
    const config = { security: securityAccess.unscoped([PrincipalType.USER]) }
    app.post('/', { config: { ...config, rateLimit: { max: 10, timeWindow: '1 minute' } }, bodyLimit: 28 * 1024 * 1024 + 4096, schema: { body: z.object({ projectId: Id, name: z.string().trim().min(1).max(255), mimeType: z.enum(HOSTED_AI_FILE_MIME_TYPES), data: z.string().min(4).max(Math.ceil(HOSTED_AI_FILE_MAX_BYTES / 3) * 4) }).strict() } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return reply.code(201).send(await hostedAiFiles.upload({ principal: request.principal, ...request.body, log: request.log }))
    })
    app.get('/', { config, schema: { querystring: project } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return hostedAiFiles.list({ principal: request.principal, ...request.query, log: request.log })
    })
    app.get('/:id', { config, schema: { params: z.object({ id: Id }), querystring: project } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return hostedAiFiles.get({ principal: request.principal, ...request.query, fileId: request.params.id, log: request.log })
    })
    app.delete('/:id', { config, schema: { params: z.object({ id: Id }), querystring: project } }, async (request, reply) => {
        await hostedAiFiles.remove({ principal: request.principal, ...request.query, fileId: request.params.id, log: request.log })
        return reply.code(204).send()
    })
}
