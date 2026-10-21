import { PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { domainHelper } from '../helper/domain-helper'
import { todoService } from './todo-service'

const Id = z.string().length(21).regex(/^[A-Za-z0-9_-]+$/)
const Params = z.object({ id: Id })
const Option = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(1000).optional(), variant: z.string().min(1).max(40), continueFlow: z.boolean() })
const Create = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(20000).default(''), statusOptions: z.array(Option).min(1).max(20).refine(items => new Set(items.map(item => item.name)).size === items.length, 'Status names must be unique.'), flowId: Id, runId: Id.optional(), assigneeId: Id.optional(), resolveUrl: z.string().url().max(2000) }).strict()

export const todoController: FastifyPluginAsyncZod = async app => {
    const engine = { security: securityAccess.engine() }
    const read = { security: securityAccess.unscoped([PrincipalType.USER, PrincipalType.ENGINE]) }
    const user = { security: securityAccess.unscoped([PrincipalType.USER]) }
    app.post('/', { config: engine, schema: { body: Create } }, async (request, reply) => reply.code(201).send(await todoService(request.log).create(request.principal, request.body)))
    app.get('/assignees', { config: engine }, async request => todoService(request.log).assignees(request.principal))
    app.get('/:id', { config: read, schema: { params: Params } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return todoService(request.log).get(request.principal, request.params.id)
    })
    app.post('/:id/wait', { config: engine, schema: { params: Params, body: z.object({ flowRunId: Id, waitpointId: Id }).strict() } }, async request => todoService(request.log).wait(request.principal, request.params.id, request.body))
    // Link scanners may open this route. It neither reads task details nor changes state.
    app.get('/:id/resolve', { config: { security: securityAccess.public() }, schema: { params: Params, querystring: z.object({ status: z.string().max(80).optional(), isTest: z.string().max(10).optional() }) } }, async (request, reply) => {
        const target = new URL(await domainHelper.getPublicUrl({ path: `todos/${request.params.id}/resolve` }))
        if (request.query.status) target.searchParams.set('status', request.query.status)
        void reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        return reply.redirect(target.href, 303)
    })
    app.post('/:id/resolve', { config: user, schema: { params: Params, body: z.object({ status: z.string().min(1).max(80), message: z.string().max(4000).optional() }).strict() } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store')
        return todoService(request.log).resolve(request.principal, request.params.id, request.body)
    })
}
