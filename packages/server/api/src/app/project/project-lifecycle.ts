import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { Project, ProjectType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { distributedLock } from '../database/redis-connections'
import { projectRepo } from './project-repo'

async function runWhileActive<T>({
    projectId,
    log,
    operation,
}: LifecycleParams<T>): Promise<T> {
    const project = await getActiveProject(projectId)
    if (project.type === ProjectType.PERSONAL) return operation(project)
    return distributedLock(log).runExclusive({
        key: `project-lifecycle-${projectId}`,
        timeoutInSeconds: 300,
        fn: async () => operation(await getActiveProject(projectId)),
    })
}

async function getActiveProject(projectId: string): Promise<Project> {
    const project = await projectRepo().findOneBy({ id: projectId })
    if (!project)
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityType: 'project', entityId: projectId },
        })
    return project
}

export const projectLifecycle = { runWhileActive }

type LifecycleParams<T> = {
    projectId: string
    log: FastifyBaseLogger
    operation: (project: Project) => Promise<T>
}
