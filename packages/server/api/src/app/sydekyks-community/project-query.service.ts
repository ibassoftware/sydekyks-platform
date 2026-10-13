import { FlowStatus, PiecesFilterType, PlatformRole, Project, ProjectType, ProjectWithLimits, UserStatus } from '@activepieces/shared'
import { In } from 'typeorm'
import { flowRepo } from '../flows/flow/flow.repo'
import { userRepo } from '../user/user-service'

async function enrich({ projects }: { projects: Project[] }): Promise<ProjectWithLimits[]> {
    if (projects.length === 0) return []
    const projectIds = projects.map(project => project.id)
    const platformIds = [...new Set(projects.map(project => project.platformId))]
    const [flowCounts, users] = await Promise.all([
        flowRepo().createQueryBuilder('flow')
            .select('flow."projectId"', 'projectId')
            .addSelect('COUNT(*)', 'totalFlows')
            .addSelect('COUNT(*) FILTER (WHERE flow.status = :enabled)', 'activeFlows')
            .addSelect('MAX(flow.updated)', 'lastFlowUpdated')
            .where('flow."projectId" IN (:...projectIds)', { projectIds, enabled: FlowStatus.ENABLED })
            .groupBy('flow."projectId"')
            .getRawMany<FlowCounts>(),
        userRepo().find({ where: { platformId: In(platformIds) }, select: { id: true, platformId: true, platformRole: true, status: true } }),
    ])
    const countsByProject = new Map(flowCounts.map(count => [count.projectId, count]))
    return projects.map(project => {
        const count = countsByProject.get(project.id)
        const projectUsers = users.filter(user => user.platformId === project.platformId && (
            user.id === project.ownerId || (project.type === ProjectType.TEAM && (user.platformRole === PlatformRole.ADMIN || user.platformRole === PlatformRole.OPERATOR))
        ))
        return {
            ...project,
            plan: { id: project.id, created: project.created, updated: project.updated, projectId: project.id, name: 'Sydekyks', locked: false, piecesFilterType: PiecesFilterType.NONE, pieces: [], activeFlowsLimit: null },
            analytics: {
                totalUsers: projectUsers.length,
                activeUsers: projectUsers.filter(user => user.status === UserStatus.ACTIVE).length,
                totalFlows: Number(count?.totalFlows ?? 0),
                activeFlows: Number(count?.activeFlows ?? 0),
                lastFlowUpdated: count?.lastFlowUpdated ?? null,
            },
        }
    })
}

export const communityProjectQueries = { enrich }

type FlowCounts = { projectId: string, totalFlows: string, activeFlows: string, lastFlowUpdated: string | null }
