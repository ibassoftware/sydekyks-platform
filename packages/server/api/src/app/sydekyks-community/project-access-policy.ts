import { Permission, PlatformRole, PrincipalType, ProjectType, UserStatus, WebsocketServerEvent } from '@activepieces/shared'

function canAccessProject({ principal, project, user, write, operational = false }: ProjectAccessParams): boolean {
    if (project.deleted || !principal.platformId || principal.platformId !== project.platformId) return false
    if (principal.type === PrincipalType.ENGINE) return principal.projectId === project.id
    if (principal.type !== PrincipalType.USER || !user || user.id !== principal.id || user.status !== UserStatus.ACTIVE || user.platformId !== project.platformId) return false
    // Set only by server-side role/assignment lookup, never a browser field.
    if (operational && user.platformRole === PlatformRole.OPERATOR) return true
    if (project.type === ProjectType.PERSONAL && project.ownerId !== user.id) return false
    if (project.ownerId === user.id || user.platformRole === PlatformRole.ADMIN) return true
    return !write && user.platformRole === PlatformRole.OPERATOR
}

function canHandleSocketEvent({ event, permission, permissions }: SocketEventParams): boolean {
    if (event === WebsocketServerEvent.DISCONNECT) return true
    const readEvents = [WebsocketServerEvent.JOIN_PRESENCE, WebsocketServerEvent.LEAVE_PRESENCE, WebsocketServerEvent.UNLOCK_RESOURCE]
    const requiredPermission = permission ?? (readEvents.some(readEvent => readEvent === event) ? Permission.READ_FLOW : Permission.WRITE_FLOW)
    return permissions?.has(requiredPermission) ?? false
}

export const communityProjectAccess = { canAccessProject, canHandleSocketEvent }

type SocketEventParams = {
    event: string
    permission?: Permission
    permissions?: ReadonlySet<Permission>
}

type ProjectAccessParams = {
    principal: {
        id: string
        type: PrincipalType
        platformId?: string
        projectId?: string
    }
    project: {
        id: string
        platformId: string
        ownerId: string
        type: ProjectType
        deleted?: string | null
    }
    user?: {
        id: string
        platformId?: string | null
        platformRole: PlatformRole
        status: UserStatus
    }
    write: boolean
    operational?: boolean
}
