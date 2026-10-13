import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { FileType, PlatformRole, PrincipalType, UpdateMeResponse, UserWithMetaInformation } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { userIdentityRepository } from '../authentication/user-identity/user-identity-service'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { fileService } from '../file/file.service'
import { attachMultipartFieldsToBody } from '../helper/multipart-body'
import { userService } from '../user/user-service'

const communityUserController: FastifyPluginAsyncZod = async app => {
    app.get('/:id', { config: { security: securityAccess.unscoped([PrincipalType.USER]) }, schema: { params: z.object({ id: z.string() }), response: { 200: UserWithMetaInformation } } }, async request => {
        const caller = await userService(request.log).getOrThrow({ id: request.principal.id })
        const target = await userService(request.log).getOrThrow({ id: request.params.id === 'me' ? caller.id : request.params.id })
        if (target.platformId !== caller.platformId || (target.id !== caller.id && caller.platformRole !== PlatformRole.ADMIN)) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'This account cannot access the requested user' } })
        return userService(request.log).getMetaInformation({ id: target.id })
    })
    app.post('/me', { config: { security: securityAccess.unscoped([PrincipalType.USER]) }, preValidation: attachMultipartFieldsToBody, schema: { body: z.object({ profilePicture: z.object({ type: z.literal('file'), filename: z.string(), mimetype: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.instanceof(Buffer) }).optional() }), response: { 200: UpdateMeResponse } } }, async request => {
        const user = await userService(request.log).getOrThrow({ id: request.principal.id })
        if (!user.platformId) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
        const url = await fileService(request.log).uploadPublicAsset({ platformId: user.platformId, type: FileType.USER_PROFILE_PICTURE, file: request.body.profilePicture, metadata: { userId: user.id, platformId: user.platformId } })
        if (url) await userIdentityRepository().update({ id: user.identityId }, { imageUrl: url })
        return UpdateMeResponse.parse(await userIdentityRepository().findOneByOrFail({ id: user.identityId }))
    })
    app.delete('/me/profile-picture', { config: { security: securityAccess.unscoped([PrincipalType.USER]) } }, async request => {
        const user = await userService(request.log).getOrThrow({ id: request.principal.id })
        await userIdentityRepository().update({ id: user.identityId }, { imageUrl: null })
        return { success: true }
    })
}

export const communityUserModule: FastifyPluginAsyncZod = async app => {
    await app.register(communityUserController, { prefix: '/v1/users' }) 
}
