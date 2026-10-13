import { Permission } from '@activepieces/core-utils'
import { PrincipalType, ProjectWithLimits } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { communityAuthorization } from './project-access'
import { communityProjectManagement } from './project-management.service'
import { communityProjectQueries } from './project-query.service'
import { CommunityProjectCreate, CommunityProjectUpdate } from './project-requests'

async function populateProject({ projectId, log }: { projectId: string, log: FastifyBaseLogger }): Promise<ProjectWithLimits> {
    const project = await projectService(log).getOneOrThrow(projectId)
    const [result] = await communityProjectQueries.enrich({ projects: [project] })
    return result
}

const communityProjectController: FastifyPluginAsyncZod = async app => {
    app.get('/', { config: { security: securityAccess.unscoped([PrincipalType.USER]) } }, async request => {
        const user = await userService(request.log).getOrThrow({ id: request.principal.id })
        if (!user.platformId) return { data: [], next: null, previous: null }
        const projects = await projectService(request.log).getAllForUser({ platformId: user.platformId, userId: user.id, isPrivileged: userService(request.log).isUserPrivileged(user) })
        return { data: await communityProjectQueries.enrich({ projects }), next: null, previous: null }
    })
    app.post('/', {
        config: { security: securityAccess.publicPlatform([PrincipalType.USER]) },
        schema: { body: CommunityProjectCreate, response: { 201: ProjectWithLimits } },
    }, async (request, reply) => {
        const project = await communityProjectManagement(request.log).create({ principal: request.principal, request: request.body })
        return reply.code(201).send(await populateProject({ projectId: project.id, log: request.log }))
    })
    app.post('/:id', {
        config: { security: securityAccess.publicPlatform([PrincipalType.USER]) },
        schema: { params: z.object({ id: z.string() }), body: CommunityProjectUpdate, response: { 200: ProjectWithLimits } },
    }, async request => {
        const project = await communityProjectManagement(request.log).update({ principal: request.principal, projectId: request.params.id, request: request.body })
        return populateProject({ projectId: project.id, log: request.log })
    })
    app.delete('/:id', {
        config: { security: securityAccess.publicPlatform([PrincipalType.USER]) },
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        await communityProjectManagement(request.log).archive({ principal: request.principal, projectId: request.params.id })
        return reply.code(204).send()
    })
    app.post('/:id/restore', {
        config: { security: securityAccess.publicPlatform([PrincipalType.USER]) },
        schema: { params: z.object({ id: z.string() }), response: { 200: ProjectWithLimits } },
    }, async request => {
        const project = await communityProjectManagement(request.log).restore({ principal: request.principal, projectId: request.params.id })
        return populateProject({ projectId: project.id, log: request.log })
    })
    app.get('/:id', { config: { security: securityAccess.unscoped([PrincipalType.USER]) }, schema: { params: z.object({ id: z.string() }), response: { 200: ProjectWithLimits } } }, async request => {
        await communityAuthorization.assertProjectAccess({ principal: request.principal, projectId: request.params.id, permission: Permission.READ_PROJECT, log: request.log })
        return populateProject({ projectId: request.params.id, log: request.log })
    })
}

export const communityProjectModule: FastifyPluginAsyncZod = async app => {
    await app.register(communityProjectController, { prefix: '/v1/projects' }) 
}
