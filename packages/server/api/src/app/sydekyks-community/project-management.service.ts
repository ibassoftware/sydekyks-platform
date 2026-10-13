import {
    ActivepiecesError,
    ErrorCode,
    Permission,
} from '@activepieces/core-utils'
import {
    FlowRunStatus,
    FlowStatus,
    Principal,
    PrincipalType,
    Project,
    ProjectType,
    UserStatus,
} from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { In, IsNull } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { transaction } from '../core/db/transaction'
import { flowRepo } from '../flows/flow/flow.repo'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { projectLifecycle } from '../project/project-lifecycle'
import { projectRepo, projectService } from '../project/project-service'
import { TriggerSourceEntity } from '../trigger/trigger-source/trigger-source-entity'
import { userService } from '../user/user-service'
import { communityAuthorization } from './project-access'
import { communityProjectAccess } from './project-access-policy'
import {
    CommunityProjectCreate,
    CommunityProjectUpdate,
} from './project-requests'

export const communityProjectManagement = (log: FastifyBaseLogger) => ({
    async create({ principal, request }: CreateParams): Promise<Project> {
        const user = await getCurrentUser({ principal, log })
        return projectService(log).create({
            platformId: user.platformId,
            ownerId: user.id,
            displayName: request.displayName,
            type: ProjectType.TEAM,
        })
    },
    async update({
        principal,
        projectId,
        request,
    }: UpdateParams): Promise<Project> {
        await communityAuthorization.assertProjectAccess({
            principal,
            projectId,
            permission: Permission.WRITE_PROJECT,
            log,
        })
        const user = await getCurrentUser({ principal, log })
        const project = await projectRepo().findOneByOrFail({
            id: projectId,
            platformId: user.platformId,
        })
        assertAdditionalProject(project)
        await projectRepo().update(
            { id: projectId, platformId: user.platformId, deleted: IsNull() },
            request,
        )
        return projectService(log).getOneOrThrow(projectId)
    },
    async archive({
        principal,
        projectId,
    }: ProjectMutationParams): Promise<void> {
        await communityAuthorization.assertProjectAccess({
            principal,
            projectId,
            permission: Permission.WRITE_PROJECT,
            log,
        })
        const user = await getCurrentUser({ principal, log })
        await projectLifecycle.runWhileActive({
            projectId,
            log,
            operation: async () =>
                transaction(async (manager) => {
                    const project = await projectRepo(manager).findOneOrFail({
                        where: { id: projectId, platformId: user.platformId },
                        lock: { mode: 'pessimistic_write' },
                    })
                    assertAdditionalProject(project)
                    const enabledFlows = await flowRepo(manager).countBy({
                        projectId,
                        status: FlowStatus.ENABLED,
                    })
                    const triggers = await repoFactory(TriggerSourceEntity)(
                        manager,
                    ).countBy({ projectId })
                    if (enabledFlows > 0 || triggers > 0)
                        throwValidation('PROJECT_HAS_ENABLED_FLOWS')
                    const unfinishedRuns = await repoFactory(FlowRunEntity)(
                        manager,
                    ).countBy({
                        projectId,
                        status: In([
                            FlowRunStatus.QUEUED,
                            FlowRunStatus.RUNNING,
                            FlowRunStatus.PAUSED,
                        ]),
                    })
                    if (unfinishedRuns > 0)
                        throwValidation('PROJECT_HAS_UNFINISHED_RUNS')
                    await projectRepo(manager).softDelete({
                        id: projectId,
                        platformId: user.platformId,
                    })
                }),
        })
    },
    async restore({
        principal,
        projectId,
    }: ProjectMutationParams): Promise<Project> {
        const user = await getCurrentUser({ principal, log })
        const project = await projectRepo().findOne({
            where: { id: projectId, platformId: user.platformId },
            withDeleted: true,
        })
        if (
            !project ||
      !communityProjectAccess.canAccessProject({
          principal: {
              id: user.id,
              type: PrincipalType.USER,
              platformId: user.platformId,
          },
          project: { ...project, deleted: null },
          user,
          write: true,
      })
        )
            throwAuthorization()
        assertAdditionalProject(project)
        await projectRepo().restore({ id: projectId, platformId: user.platformId })
        return projectService(log).getOneOrThrow(projectId)
    },
})

async function getCurrentUser({ principal, log }: CurrentUserParams) {
    if (principal.type !== PrincipalType.USER) throwAuthorization()
    const user = await userService(log).get({ id: principal.id })
    if (
        !user ||
    !user.platformId ||
    user.platformId !== principal.platform.id ||
    user.status !== UserStatus.ACTIVE
    )
        throwAuthorization()
    return { ...user, platformId: user.platformId }
}

function assertAdditionalProject(project: Project): void {
    if (project.type !== ProjectType.TEAM) throwValidation('PERSONAL_PROJECT')
}

function throwAuthorization(): never {
    throw new ActivepiecesError({
        code: ErrorCode.AUTHORIZATION,
        params: { message: 'This account cannot manage the requested workspace.' },
    })
}

function throwValidation(message: string): never {
    throw new ActivepiecesError({
        code: ErrorCode.VALIDATION,
        params: { message },
    })
}

type CurrentUserParams = { principal: Principal, log: FastifyBaseLogger }
type ProjectMutationParams = { principal: Principal, projectId: string }
type CreateParams = { principal: Principal, request: CommunityProjectCreate }
type UpdateParams = ProjectMutationParams & { request: CommunityProjectUpdate }
