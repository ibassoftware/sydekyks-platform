import { ActivepiecesError, ErrorCode, Permission } from '@activepieces/core-utils'
import { PlatformRole, Principal, PrincipalType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { databaseConnection } from '../database/database-connection'
import { hasOperationalAccess, isOperationalUser } from '../hosting/hosting-access-policy'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { isHostedSharedProject } from '../hosting/hosting-shared-project'
import { hostingTransactions } from '../hosting/hosting-transactions'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { communityProjectAccess } from './project-access-policy'

async function assertProjectAccess({ principal, projectId, permission, log }: AssertProjectAccessParams): Promise<void> {
    const project = await projectService(log).getOne(projectId)
    const user = principal.type === PrincipalType.USER ? await userService(log).get({ id: principal.id }) : undefined
    const operational = !!user && hostingConfiguration.getServiceMode() === 'hosted' && await hasOperationalAccess({ manager: databaseConnection().manager, user })
    if (user && hostingConfiguration.getServiceMode() === 'hosted' && isOperationalUser(user) && !operational) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'Operational workspace access has been revoked.' } })
    const shared = !!project && hostingConfiguration.getServiceMode() === 'hosted' && await isHostedSharedProject(databaseConnection().manager, project.platformId, projectId)
    const memberManagementDenied = user?.platformRole === PlatformRole.MEMBER && shared && permission !== undefined && managementPermissions.has(permission)
    const permitted = !memberManagementDenied && project && communityProjectAccess.canAccessProject({
        principal: {
            id: principal.id,
            type: principal.type,
            platformId: 'platform' in principal ? principal.platform.id : undefined,
            projectId: 'projectId' in principal ? principal.projectId : undefined,
        },
        project,
        user: user ?? undefined,
        operational,
        shared,
        write: permission === undefined || !permission.startsWith('READ_'),
    })
    if (permitted && operational && user) await hostingTransactions.event({ manager: databaseConnection().manager, platformId: project.platformId, event: 'operational.project.authorized', payload: { actorIdentityId: user.identityId, actorUserId: user.id, projectId, permission: permission ?? 'write' } })
    if (!permitted) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'This account cannot access the requested workspace.' } })
}

async function getUserPermissions({ userId, platformId, projectId, log }: GetUserPermissionsParams): Promise<ReadonlySet<Permission>> {
    const project = await projectService(log).getOne(projectId)
    const user = await userService(log).get({ id: userId })
    if (!project || !user || !user.platformId || (platformId !== undefined && user.platformId !== platformId)) return new Set()
    const principal = { id: user.id, type: PrincipalType.USER, platformId: user.platformId }
    const operational = hostingConfiguration.getServiceMode() === 'hosted' && await hasOperationalAccess({ manager: databaseConnection().manager, user })
    if (hostingConfiguration.getServiceMode() === 'hosted' && isOperationalUser(user) && !operational) return new Set()
    const shared = hostingConfiguration.getServiceMode() === 'hosted' && await isHostedSharedProject(databaseConnection().manager, project.platformId, projectId)
    const mayRead = communityProjectAccess.canAccessProject({ principal, project, user, operational, shared, write: false })
    const mayWrite = communityProjectAccess.canAccessProject({ principal, project, user, operational, shared, write: true })
    return new Set(Object.values(Permission).filter(permission => mayRead && (permission.startsWith('READ_') || mayWrite) && !(shared && user.platformRole === PlatformRole.MEMBER && managementPermissions.has(permission))))
}

const managementPermissions = new Set<Permission>([Permission.WRITE_PROJECT, Permission.WRITE_PROJECT_MEMBER, Permission.WRITE_INVITATION, Permission.WRITE_PROJECT_RELEASE, Permission.PUBLISH_SENSITIVE_FLOW_ACCESS])

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
