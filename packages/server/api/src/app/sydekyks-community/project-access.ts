import { ActivepiecesError, ErrorCode, Permission } from '@activepieces/core-utils'
import { Principal, PrincipalType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { communityProjectAccess } from './project-access-policy'

async function assertProjectAccess({ principal, projectId, permission, log }: AssertProjectAccessParams): Promise<void> {
    const project = await projectService(log).getOne(projectId)
    const user = principal.type === PrincipalType.USER ? await userService(log).get({ id: principal.id }) : undefined
    const permitted = project && communityProjectAccess.canAccessProject({
        principal: {
            id: principal.id,
            type: principal.type,
            platformId: 'platform' in principal ? principal.platform.id : undefined,
            projectId: 'projectId' in principal ? principal.projectId : undefined,
        },
        project,
        user: user ?? undefined,
        write: permission === undefined || !permission.startsWith('READ_'),
    })
    if (!permitted) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'This account cannot access the requested workspace.' } })
}

async function getUserPermissions({ userId, platformId, projectId, log }: GetUserPermissionsParams): Promise<ReadonlySet<Permission>> {
    const project = await projectService(log).getOne(projectId)
    const user = await userService(log).get({ id: userId })
    if (!project || !user || !user.platformId || (platformId !== undefined && user.platformId !== platformId)) return new Set()
    const principal = { id: user.id, type: PrincipalType.USER, platformId: user.platformId }
    const mayRead = communityProjectAccess.canAccessProject({ principal, project, user, write: false })
    const mayWrite = communityProjectAccess.canAccessProject({ principal, project, user, write: true })
    return new Set(Object.values(Permission).filter(permission => mayRead && (permission.startsWith('READ_') || mayWrite)))
}

export const communityAuthorization = { assertProjectAccess, getUserPermissions }

type AssertProjectAccessParams = {
    principal: Principal
    projectId: string
    permission?: Permission
    log: FastifyBaseLogger
}

type GetUserPermissionsParams = {
    userId: string
    platformId?: string
    projectId: string
    log: FastifyBaseLogger
}
