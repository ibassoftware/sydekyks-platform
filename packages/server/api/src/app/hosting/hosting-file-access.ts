import { ActivepiecesError, ErrorCode, Permission } from '@activepieces/core-utils'
import { File, FileType, Principal, PrincipalType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { communityAuthorization } from '../sydekyks-community/project-access'

export function isPublicHostedFile(type: FileType): boolean {
    return type === FileType.PLATFORM_ASSET || type === FileType.USER_PROFILE_PICTURE
}

// A signed private-file URL is a locator, not authorization to the tenant's data.
export async function authorizeHostedFile({ principal, file, log }: { principal: Principal, file: File, log: FastifyBaseLogger }): Promise<void> {
    if (!file.platformId || !file.projectId || (principal.type !== PrincipalType.USER && principal.type !== PrincipalType.ENGINE) || principal.platform.id !== file.platformId || (principal.type === PrincipalType.ENGINE && principal.projectId !== file.projectId)) {
        throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'A current workspace session is required to read this file.' } })
    }
    await communityAuthorization.assertProjectAccess({ principal, projectId: file.projectId, permission: Permission.READ_FLOW, log })
}
