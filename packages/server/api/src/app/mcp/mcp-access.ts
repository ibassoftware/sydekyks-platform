import { isNil, Permission } from '@activepieces/core-utils'
import { McpReachResponse, McpToolResult, Project } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { deny } from './mcp-permissions'

export const mcpAccess = {
    listAccessibleProjects,
    resolveReach,
    hasMcpReach,
    hasMcpAccessToProject,
    noMcpReachResult,
}

async function listAccessibleProjects({ platformId, userId, log }: UserScope): Promise<Project[]> {
    return listProjectsForUser({ platformId, userId, log })
}

async function resolveReach({ platformId, userId, log }: UserScope): Promise<McpReachResponse> {
    const projects = await listProjectsForUser({ platformId, userId, log })
    return { projectIds: projects.map(project => project.id) }
}

async function hasMcpReach({ platformId, userId, log }: UserScope): Promise<boolean> {
    const { projectIds } = await resolveReach({ platformId, userId, log })
    return isNil(projectIds) || projectIds.length > 0
}

async function hasMcpAccessToProject({ platformId, userId, projectId, log }: UserScope & { projectId: string }): Promise<boolean> {
    const projects = await listProjectsForUser({ platformId, userId, log })
    return projects.some(project => project.id === projectId)
}

function noMcpReachResult(toolTitle: string): McpToolResult {
    return deny(`❌ Permission denied: your role does not have the "${Permission.READ_MCP}" permission in any project. Cannot execute "${toolTitle}".`)
}

async function listProjectsForUser({ platformId, userId, log }: UserScope): Promise<Project[]> {
    const user = await userService(log).get({ id: userId })
    if (!user || user.platformId !== platformId) return []
    return projectService(log).getAllForUser({ platformId, userId, isPrivileged: userService(log).isUserPrivileged(user) })
}

type UserScope = {
    platformId: string
    userId: string
    log: FastifyBaseLogger
}
