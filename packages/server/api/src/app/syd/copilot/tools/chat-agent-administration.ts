import { createHash } from 'node:crypto'
import { ActivepiecesError, AIProviderName, apId, ErrorCode, Permission, sanitizeObjectForPostgresql, SeekPage, tryCatch } from '@activepieces/core-utils'
import { modelTierCatalog } from '@activepieces/server-utils'
import { Agent, AgentConfig, AgentListSort, AgentSummary, AgentToolType, AgentVisibility, CreateAgentRequest, DefaultProjectRole, PlatformRole, Project, ProjectMember, ProjectType, UpdateAgentRequest } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { Brackets, EntityManager, In } from 'typeorm'
import { transaction } from '../../../core/db/transaction'
import { databaseConnection } from '../../../database/database-connection'
import { publishHooksFactory } from '../../../flows/flow/flow-publish-hooks'
import { getFolderIdFromRequest } from '../../../flows/flow/flow.service'
import { publishedFlowsUsingAgent, publishedFlowVersionsUsingAgent } from '../../../flows/flow-version/flow-version.service'
import { buildPaginator } from '../../../helper/pagination/build-paginator'
import { paginationHelper } from '../../../helper/pagination/pagination-utils'
import { Order, OrderByConfig } from '../../../helper/pagination/paginator'
import { resolvePermissionChecker } from '../../../mcp/mcp-permissions'
import { projectService } from '../../../project/project-service'
import { userService } from '../../../user/user-service'
import { sydCopilotContext } from '../copilot-context'
import { SydChatManagedAgentEntity } from '../models/chat-managed-agent.entity'

function agentRepo() {
    return databaseConnection().getRepository(SydChatManagedAgentEntity)
}

export const sydChatAgentAdministration = (log: FastifyBaseLogger) => ({
    async create({ platformId, projectId, ownerId, request }: CreateParams): Promise<Agent> {
        const projects = await sydCopilotContext.getUserProjects({ platformId, userId: ownerId, log })
        if (!projects.some((project) => project.id === projectId)) throw agentNotFound(projectId)
        const visibility = request.visibility ?? AgentVisibility.PROJECT
        const sharedWithUserIds = await resolveShare({ visibility, requested: request.sharedWithUserIds, stored: [], projectId, log })
        const draft = await withDefaultModel({ platformId, projectId, draft: request.draft, log })
        return agentRepo().save({ id: apId(), externalId: apId(), projectId, ownerId,
            folderId: await getFolderIdFromRequest({ projectId, folderId: request.folderId ?? undefined, folderName: undefined, log }), displayName: request.displayName, description: request.description ?? null, icon: request.icon, color: request.color,
            visibility, sharedWithUserIds, draft: sanitizeObjectForPostgresql(draft), published: null })
    },

    async list({ platformId, userId, projectId, search, sort, cursor, limit = 20 }: ListParams): Promise<SeekPage<AgentSummary>> {
        const projects = await resolveReadableProjects({ platformId, userId, projectId, log })
        if (!projects.length) return paginationHelper.createPage([], null)
        const decoded = paginationHelper.decodeCursor(cursor)
        const paginator = buildPaginator({ entity: SydChatManagedAgentEntity, query: { limit, orderBy: orderByForSort(sort), afterCursor: decoded.nextCursor, beforeCursor: decoded.previousCursor } })
        const query = visibleAgents({ userId, isProjectAdmin: false }).andWhere({ projectId: In(projects.map((project) => project.id)) })
        if (search?.trim()) query.andWhere('(LOWER(agent."displayName") LIKE :search OR LOWER(COALESCE(agent.description, \'\')) LIKE :search)', { search: `%${search.trim().toLowerCase()}%` })
        const result = await paginator.paginate(query)
        return paginationHelper.createPage(result.data.map((agent) => toSummary({ agent, project: projects.find((project) => project.id === agent.projectId) })), result.cursor)
    },

    async getOneOrThrow({ id, projectId, userId }: GetParams): Promise<Agent> {
        const row = await visibleAgents({ userId, isProjectAdmin: await isProjectAdministrator({ projectId, userId, log }) }).andWhere({ id, projectId }).getOne()
        if (!row) throw agentNotFound(id)
        return row
    },

    async update({ id, projectId, platformId, userId, request }: UpdateParams): Promise<Agent> {
        const observed = await this.getOneOrThrow({ id, projectId, userId })
        await assertMayChangeWhoCanSee({ agent: observed, request, projectId, userId, log })
        const visibility = request.visibility ?? observed.visibility
        const shares = await resolveShare({ visibility, requested: request.sharedWithUserIds, stored: observed.sharedWithUserIds, projectId, log })
        if (!(await sydCopilotContext.getUserProjects({ platformId, userId, log })).some((project) => project.id === projectId)) throw agentNotFound(id)
        const folderId = request.folderId === undefined ? undefined : await getFolderIdFromRequest({ projectId, folderId: request.folderId ?? undefined, folderName: undefined, log })
        await transaction(async (manager) => {
            await lockedAgentInProjectOrThrow({ entityManager: manager, id, projectId })
            await manager.getRepository(SydChatManagedAgentEntity).save({ id,
                ...(request.displayName !== undefined ? { displayName: request.displayName } : {}),
                ...(request.description !== undefined ? { description: request.description } : {}),
                ...(request.draft !== undefined ? { draft: sanitizeObjectForPostgresql(AgentConfig.parse(request.draft)) } : {}), visibility, sharedWithUserIds: shares,
                ...(request.folderId !== undefined ? { folderId: folderId ?? null } : {}),
                ...(request.icon !== undefined ? { icon: request.icon } : {}),
                ...(request.color !== undefined ? { color: request.color } : {}),
            })
        })
        return this.getOneOrThrow({ id, projectId, userId })
    },

    async publish({ id, projectId, platformId, userId }: GetParams & { platformId: string }): Promise<Agent> {
        const reviewed = await this.getOneOrThrow({ id, projectId, userId })
        if (!reviewed.draft.instructions.trim()) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'An agent needs instructions before it can be published' } })
        assertDraftIsCoherent(reviewed.draft)
        await assertMayPublishWhatFlowsAlreadyRun({ agent: reviewed, projectId, platformId, userId, log })
        const needsApproval = await publishingNeedsApprovalHere({ projectId, platformId, userId, log })
        const query = agentRepo().createQueryBuilder().update().set({ published: () => '"draft"' }).where({ id, projectId })
            .andWhere('"draft" = :reviewed::jsonb', { reviewed: JSON.stringify(reviewed.draft) })
            .andWhere(visibleToUser({ userId, prefix: '', isProjectAdmin: await isProjectAdministrator({ projectId, userId, log }) }))
        if (needsApproval) {
            const consuming = publishedFlowVersionsUsingAgent({ projectId, agentExternalId: reviewed.externalId, alias: 'consuming_version' })
            query.andWhere(`NOT EXISTS (${consuming.getQuery()})`).setParameters(consuming.getParameters())
        }
        const result = await query.returning('id').execute()
        if (!Array.isArray(result.raw) || !result.raw.length) {
            await assertMayPublishWhatFlowsAlreadyRun({ agent: reviewed, projectId, platformId, userId, log })
            throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'The agent changed while it was being published, review it and publish again' } })
        }
        return this.getOneOrThrow({ id, projectId, userId })
    },

    async editDraftTools({ id, projectId, userId, edit }: EditDraftToolsParams): Promise<Agent | null> {
        await this.getOneOrThrow({ id, projectId, userId })
        return transaction(async (manager) => {
            const row = await lockedAgentInProjectOrThrow({ entityManager: manager, id, projectId })
            const replacement = edit(row.draft.tools)
            if (!replacement) return null
            const draft = sanitizeObjectForPostgresql(AgentConfig.parse({ ...row.draft, tools: replacement }))
            await manager.getRepository(SydChatManagedAgentEntity).save({ id, draft })
            return { ...row, draft }
        })
    },

    async publishedFlowsUsing({ agent, projectId, userId, nameLimit = 3 }: { agent: Agent, projectId: string, userId: string, nameLimit?: number }) {
        const permission = await resolvePermissionChecker({ userId, projectId, log })
        return publishedFlowsUsingAgent({ projectId, agentExternalId: agent.externalId, nameLimit: permission.check(Permission.READ_FLOW, '__name_flows_using_agent') ? 0 : nameLimit })
    },
})

function visibleToUser({ userId, prefix, isProjectAdmin }: { userId: string, prefix: string, isProjectAdmin: boolean }): Brackets {
    return new Brackets((where) => {
        where.where(`${prefix}"visibility" = :visibility`, { visibility: AgentVisibility.PROJECT }).orWhere(`${prefix}"ownerId" = :userId`, { userId }).orWhere(`:userId = ANY(${prefix}"sharedWithUserIds")`, { userId })
        if (isProjectAdmin) where.orWhere('TRUE')
    })
}

function visibleAgents(params: { userId: string, isProjectAdmin: boolean }) {
    return agentRepo().createQueryBuilder('agent').where(visibleToUser({ ...params, prefix: 'agent.' }))
}
function orderByForSort(sort?: AgentListSort): OrderByConfig[] {
    return [{ field: sort === AgentListSort.NAME ? 'displayName' : sort === AgentListSort.CREATED ? 'created' : 'updated', order: sort === AgentListSort.NAME ? Order.ASC : Order.DESC }]
}

async function isProjectAdministrator({ projectId, userId, log }: { projectId: string, userId: string, log: FastifyBaseLogger }): Promise<boolean> {
    const project = await projectService(log).getOneOrThrow(projectId)
    const user = await userService(log).getOneOrFail({ id: userId })
    if (project.ownerId === userId || (project.platformId === user.platformId && user.platformRole === PlatformRole.ADMIN)) return true
    if (!databaseConnection().hasMetadata('project_member')) return false
    return databaseConnection().getRepository<ProjectMember>('project_member').createQueryBuilder('member').innerJoin('project_role', 'role', 'role.id = member."projectRoleId"')
        .where({ projectId, userId, platformId: project.platformId }).andWhere('role.name = :name', { name: DefaultProjectRole.ADMIN }).getExists()
}

async function withDefaultModel({ draft, platformId, projectId, log }: { draft: AgentConfig, platformId: string, projectId: string, log: FastifyBaseLogger }): Promise<AgentConfig> {
    if (draft.modelName != null) return draft
    const scope = sydCopilotContext.runScopeOrThrow({ projectId })
    const resolved = await tryCatch(() => draft.provider ? sydCopilotContext.resolveRunProvider({ platformId, provider: draft.provider, providerConfigId: draft.providerConfigId ?? undefined, scope, log }) : sydCopilotContext.resolveChatProvider({ platformId, scope, log }))
    if (resolved.error) {
        if (resolved.error instanceof ActivepiecesError && resolved.error.error.code === ErrorCode.ENTITY_NOT_FOUND) return draft
        throw resolved.error
    }
    const credentials = resolved.data
    const selected = await sydCopilotContext.resolveModelId({ platformId, providerConfig: credentials, selectedModel: null, surface: 'flow', scope, log })
    const modelName = credentials.provider === AIProviderName.ACTIVEPIECES ? modelTierCatalog.current('flow').tiers.find((tier) => tier.modelId === selected)?.id ?? selected : selected
    return { ...draft, provider: credentials.provider, providerConfigId: credentials.configId, modelName }
}

async function listUsersWithProjectAccess({ projectId, log }: { projectId: string, log: FastifyBaseLogger }): Promise<string[]> {
    const project = await projectService(log).getOneOrThrow(projectId)
    const users = await userService(log).listProjectUsers({ projectId, platformId: project.platformId })
    return users.map((user) => user.id)
}

async function resolveShare({ visibility, requested, stored, projectId, log }: { visibility: AgentVisibility, requested?: string[], stored: string[], projectId: string, log: FastifyBaseLogger }): Promise<string[]> {
    if (visibility === AgentVisibility.PROJECT) return []
    const allowed = await listUsersWithProjectAccess({ projectId, log })
    const candidates = [...new Set(requested ?? stored)]
    if (requested && candidates.some((id) => !allowed.includes(id))) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'An agent can only be shared with people who already have access to its project' } })
    return candidates.filter((id) => allowed.includes(id))
}

async function assertMayDestroy({ agent, projectId, userId, log }: { agent: Agent, projectId: string, userId: string, log: FastifyBaseLogger }): Promise<void> {
    if (agent.ownerId !== userId && !await isProjectAdministrator({ projectId, userId, log })) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'Only the creator or a project admin can delete or move an agent' } })
}

async function assertMayChangeWhoCanSee({ agent, request, projectId, userId, log }: { agent: Agent, request: UpdateAgentRequest, projectId: string, userId: string, log: FastifyBaseLogger }): Promise<void> {
    if (request.visibility === undefined && request.sharedWithUserIds === undefined) return
    if (agent.ownerId !== userId && !await isProjectAdministrator({ projectId, userId, log })) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'Only the creator or a project admin can change visibility' } })
}

async function resolveReadableProjects({ platformId, userId, projectId, log }: { platformId: string, userId: string, projectId?: string, log: FastifyBaseLogger }): Promise<Project[]> {
    const user = await userService(log).getOneOrFail({ id: userId })
    const projects = await sydCopilotContext.getUserProjects({ platformId, userId, log })
    const memberships = userService(log).isUserPrivileged(user) || !databaseConnection().hasMetadata('project_member') ? [] : await databaseConnection().getRepository<ProjectMember>('project_member').createQueryBuilder('member')
        .innerJoin('project_role', 'role', 'role.id = member."projectRoleId"').where({ platformId, userId }).andWhere(':permission = ANY(role.permissions)', { permission: Permission.READ_AGENT }).getMany()
    return projects.filter((project) => (!projectId || project.id === projectId) && (userService(log).isUserPrivileged(user) || project.ownerId === userId || memberships.some((member) => member.projectId === project.id)))
}

async function lockedAgentInProjectOrThrow({ entityManager, id, projectId }: { entityManager: EntityManager, id: string, projectId: string }): Promise<Agent> {
    const row = await entityManager.getRepository(SydChatManagedAgentEntity).findOne({ where: { id, projectId }, lock: { mode: 'pessimistic_write' } })
    if (!row) throw agentNotFound(id)
    return row
}

function assertDraftIsCoherent(draft: AgentConfig): void {
    if (draft.providerConfigId && !draft.provider) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'The pinned AI key must have a provider' } })
}
async function publishingNeedsApprovalHere({ projectId, platformId, userId, log }: { projectId: string, platformId: string, userId: string, log: FastifyBaseLogger }): Promise<boolean> {
    return await publishHooksFactory.get(log).routePublish({ projectId, platformId, userId }) !== 'PUBLISH_NOW'
}
function refuseBecauseAnApprovedFlowRunsIt({ agent }: { agent: Agent }): ActivepiecesError {
    return new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: `Publishing "${agent.displayName}" would change an approved consuming flow. A user who can publish sensitive flows must approve it.` } })
}
async function assertMayPublishWhatFlowsAlreadyRun({ agent, projectId, platformId, userId, log }: { agent: Agent, projectId: string, platformId: string, userId: string, log: FastifyBaseLogger }): Promise<void> {
    if (await publishingNeedsApprovalHere({ projectId, platformId, userId, log }) && (await publishedFlowsUsingAgent({ projectId, agentExternalId: agent.externalId, nameLimit: 0 })).total) throw refuseBecauseAnApprovedFlowRunsIt({ agent })
}

function toSummary({ agent, project }: { agent: Agent, project?: Project }): AgentSummary {
    const { draft, published, ...metadata } = agent
    return { ...metadata, isPublished: published != null, projectDisplayName: project?.displayName ?? '', projectIsPrivate: project?.type === ProjectType.PERSONAL, toolCount: draft.tools.length, toolPieceNames: draft.tools.flatMap((tool) => tool.type === AgentToolType.PIECE ? [tool.pieceMetadata.pieceName] : []), toolTypes: draft.tools.map((tool) => tool.type) }
}

function describePublished({ published }: { published: AgentConfig }): { publishedDigest: string, publishedToolNames: string[] } {
    return { publishedDigest: createHash('sha256').update(JSON.stringify(published)).digest('hex').slice(0, 16), publishedToolNames: published.tools.map((tool) => tool.toolName) }
}
function agentNotFound(id: string): ActivepiecesError {
    return new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: id, entityType: 'agent' } })
}

export const sydChatAgentAdministrationSupport = { agentRepo, visibleAgents, visibleToUser, orderByForSort, isProjectAdministrator, withDefaultModel, listUsersWithProjectAccess, resolveShare, assertMayDestroy, assertMayChangeWhoCanSee, resolveReadableProjects, lockedAgentInProjectOrThrow, assertDraftIsCoherent, publishingNeedsApprovalHere, refuseBecauseAnApprovedFlowRunsIt, assertMayPublishWhatFlowsAlreadyRun, toSummary, describePublished, agentNotFound }

export type GetParams = { id: string, projectId: string, userId: string }

export type CreateParams = { platformId: string, projectId: string, ownerId: string, request: CreateAgentRequest }
export type ListParams = { platformId: string, userId: string, projectId?: string, search?: string, sort?: AgentListSort, cursor?: string | null, limit?: number }
export type UpdateParams = GetParams & { platformId: string, request: UpdateAgentRequest }
export type EditDraftToolsParams = GetParams & { edit: (tools: AgentConfig['tools']) => AgentConfig['tools'] | null }
export type ResolveProjectsParams = Parameters<typeof resolveReadableProjects>[0]
export type ResolveShareParams = Parameters<typeof resolveShare>[0]
export type VisibilityParams = Parameters<typeof visibleToUser>[0]
export type AssertShareParams = Parameters<typeof assertMayChangeWhoCanSee>[0]
