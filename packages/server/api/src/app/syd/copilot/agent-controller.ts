import { ActivepiecesError, ApId, assertNotNullOrUndefined, ErrorCode, Permission, SeekPage } from '@activepieces/core-utils'
import { Agent, AgentMovePreview, AgentSummary, AgentWithUsage, ApplicationEventName, CreateAgentRequest, GetAgentRequest, ListAgentsRequest, MoveAgentRequest, PrincipalType, UpdateAgentRequest } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { transaction } from '../../core/db/transaction'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { publishedFlowVersionsUsingAgent } from '../../flows/flow-version/flow-version.service'
import { securityHelper } from '../../helper/security-helper'
import { sydAgentSecrets } from './agent-secrets'
import { sydAgentSideEffects } from './agent-side-effects'
import { sydAgentTransfer } from './agent-transfer'
import { SydChatManagedAgentEntity } from './models/chat-managed-agent.entity'
import { sydChatAgentAdministration, sydChatAgentAdministrationSupport } from './tools/chat-agent-administration'

export const sydAgentController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', { config: { security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]) }, schema: { querystring: ListAgentsRequest, response: { 200: SeekPage(AgentSummary) } } }, async (request) => sydChatAgentAdministration(request.log).list({ platformId: request.principal.platform.id, userId: await userId(request), ...request.query }))
    app.post('/', { config: { security: securityAccess.project([PrincipalType.USER, PrincipalType.SERVICE], Permission.WRITE_AGENT, { type: ProjectResourceType.BODY }) }, schema: { body: CreateAgentRequest, response: { 201: Agent } } }, async (request, reply) => {
        const agent = await sydChatAgentAdministration(request.log).create({ platformId: request.principal.platform.id, projectId: request.projectId, ownerId: await userId(request), request: request.body })
        sydAgentSideEffects.changed({ request, agent, action: ApplicationEventName.AGENT_CREATED })
        return reply.code(201).send(sydAgentSecrets.redact(agent))
    })
    app.get('/:id', { config: readConfig(), schema: { params, querystring: GetAgentRequest, response: { 200: AgentWithUsage } } }, async (request) => {
        const actorId = await userId(request)
        const service = sydChatAgentAdministration(request.log)
        const agent = await service.getOneOrThrow({ id: request.params.id, projectId: request.projectId, userId: actorId })
        return { ...sydAgentSecrets.redact(agent), ...(request.query.includeUsage ? { publishedFlowsUsingAgent: await service.publishedFlowsUsing({ agent, projectId: request.projectId, userId: actorId }) } : {}) }
    })
    app.post('/:id', { config: writeConfig(), schema: { params, body: UpdateAgentRequest, response: { 200: Agent } } }, async (request) => {
        const scope = { id: request.params.id, projectId: request.projectId, platformId: request.principal.platform.id, userId: await userId(request) }
        const service = sydChatAgentAdministration(request.log)
        const old = await service.getOneOrThrow(scope)
        const draft = request.body.draft ? sydAgentSecrets.restoreDraft({ incoming: request.body.draft, stored: old.draft }) : undefined
        const updated = await service.update({ ...scope, request: { ...request.body, ...(draft ? { draft } : {}) } })
        const result = request.body.goLive !== false && updated.published ? await service.publish(scope) : updated
        sydAgentSideEffects.changed({ request, agent: result, action: ApplicationEventName.AGENT_UPDATED })
        return sydAgentSecrets.redact(result)
    })
    app.post('/:id/publish', { config: writeConfig(), schema: { params, response: { 200: Agent } } }, async (request) => {
        const agent = await sydChatAgentAdministration(request.log).publish({ id: request.params.id, projectId: request.projectId, platformId: request.principal.platform.id, userId: await userId(request) })
        sydAgentSideEffects.published({ request, agent })
        return sydAgentSecrets.redact(agent)
    })
    app.post('/:id/unpublish', { config: writeConfig(), schema: { params, response: { 200: Agent } } }, async (request) => {
        const scope = { id: request.params.id, projectId: request.projectId, userId: await userId(request) }
        const agent = await sydChatAgentAdministration(request.log).getOneOrThrow(scope)
        await offlineMutation({ agent, remove: false })
        sydAgentSideEffects.changed({ request, agent, action: ApplicationEventName.AGENT_UNPUBLISHED })
        return sydAgentSecrets.redact({ ...agent, published: null })
    })
    app.get('/:id/move-preview', { config: writeConfig(), schema: { params, querystring: MoveAgentRequest, response: { 200: AgentMovePreview } } }, async (request) => sydAgentTransfer.preview({ id: request.params.id, projectId: request.projectId, targetProjectId: request.query.projectId, platformId: request.principal.platform.id, userId: await userId(request), log: request.log }))
    app.post('/:id/move', { config: writeConfig(), schema: { params, body: MoveAgentRequest, response: { 200: Agent } } }, async (request) => {
        const agent = await sydAgentTransfer.move({ id: request.params.id, projectId: request.projectId, targetProjectId: request.body.projectId, platformId: request.principal.platform.id, userId: await userId(request), log: request.log })
        sydAgentSideEffects.changed({ request, agent, action: ApplicationEventName.AGENT_UPDATED })
        return sydAgentSecrets.redact(agent)
    })
    app.delete('/:id', { config: writeConfig(), schema: { params } }, async (request, reply) => {
        const agent = await sydChatAgentAdministration(request.log).getOneOrThrow({ id: request.params.id, projectId: request.projectId, userId: await userId(request) })
        await sydChatAgentAdministrationSupport.assertMayDestroy({ agent, projectId: request.projectId, userId: await userId(request), log: request.log })
        await offlineMutation({ agent, remove: true })
        sydAgentSideEffects.changed({ request, agent, action: ApplicationEventName.AGENT_DELETED })
        return reply.code(204).send()
    })
}

async function offlineMutation({ agent, remove }: { agent: Agent, remove: boolean }): Promise<void> {
    await transaction(async (manager) => {
        await sydChatAgentAdministrationSupport.lockedAgentInProjectOrThrow({ entityManager: manager, id: agent.id, projectId: agent.projectId })
        const consuming = publishedFlowVersionsUsingAgent({ projectId: agent.projectId, agentExternalId: agent.externalId, alias: 'using_agent' })
        const repo = manager.getRepository(SydChatManagedAgentEntity)
        const query = remove ? repo.createQueryBuilder().delete() : repo.createQueryBuilder().update().set({ published: null })
        const result = await query.where({ id: agent.id, projectId: agent.projectId }).andWhere(`NOT EXISTS (${consuming.getQuery()})`).setParameters(consuming.getParameters()).returning('id').execute()
        if (!Array.isArray(result.raw) || !result.raw.length) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'Published missions use this agent. Change those missions before taking it offline.' } })
    })
}

async function userId(request: FastifyRequest): Promise<string> {
    const id = await securityHelper.getUserIdFromRequest(request)
    assertNotNullOrUndefined(id, 'userId')
    return id
}
function readConfig() {
    return { security: securityAccess.project([PrincipalType.USER, PrincipalType.SERVICE], Permission.READ_AGENT, { type: ProjectResourceType.TABLE, tableName: SydChatManagedAgentEntity }) } 
}
function writeConfig() {
    return { security: securityAccess.project([PrincipalType.USER, PrincipalType.SERVICE], Permission.WRITE_AGENT, { type: ProjectResourceType.TABLE, tableName: SydChatManagedAgentEntity }) } 
}

const params = z.object({ id: ApId })
