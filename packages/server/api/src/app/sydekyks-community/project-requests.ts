import { SAFE_STRING_PATTERN } from '@activepieces/core-utils'
import { ProjectIcon } from '@activepieces/shared'
import { z } from 'zod'

const displayName = z.string().trim().min(1, 'Name is required').regex(new RegExp(SAFE_STRING_PATTERN), 'Name cannot contain periods or slashes')

export const CommunityProjectCreate = z.object({ displayName }).strict()
export type CommunityProjectCreate = z.infer<typeof CommunityProjectCreate>

export const CommunityProjectUpdate = z.object({
    displayName: displayName.optional(),
    icon: ProjectIcon.optional(),
}).strict().refine(request => request.displayName !== undefined || request.icon !== undefined, { message: 'Name is required' })
export type CommunityProjectUpdate = z.infer<typeof CommunityProjectUpdate>
