import { ApId, assertNotNullOrUndefined, SeekPage } from '@activepieces/core-utils'
import { ApEdition, ListUsersRequestBody, PasswordType, PrincipalType, SERVICE_KEY_SECURITY_OPENAPI, UpdateUserRequestBody, UserWithMetaInformation } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { authnRateLimit } from '../../core/security/rate-limit'
import { databaseConnection } from '../../database/database-connection'
import { system } from '../../helper/system/system'
import { userService } from '../user-service'
import { setPlatformUserPassword } from './platform-password-service'

export const platformUserController: FastifyPluginAsyncZod = async (app) => {

    app.post('/:id/password', {
        config: { security: securityAccess.platformAdminOnly([PrincipalType.USER]), rateLimit: authnRateLimit },
        logLevel: 'silent', bodyLimit: 4096,
        schema: { params: z.object({ id: ApId }), body: z.strictObject({ currentPassword: z.string().min(1).max(64), newPassword: PasswordType }) },
    }, async (req, reply) => {
        if (req.principal.type !== PrincipalType.USER) return reply.code(403).send()
        await setPlatformUserPassword({ dataSource: databaseConnection(), userId: req.principal.id, platformId: req.principal.platform.id, tokenVersion: req.principal.tokenVersion ?? null, targetUserId: req.params.id, ...req.body })
        req.log.info({ actorUserId: req.principal.id, targetUserId: req.params.id, platformId: req.principal.platform.id }, 'Administrator changed account password')
        return reply.code(204).send()
    })

    app.get('/',  ListUsersRequest, async (req) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        return userService(req.log).list({
            platformId,
            externalId: req.query.externalId,
            cursorRequest: req.query.cursor ?? null,
            limit: req.query.limit ?? 10,
        })
    })

    app.post('/:id', UpdateUserRequest, async (req) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        return userService(req.log).update({
            id: req.params.id,
            platformId,
            platformRole: req.body.platformRole,
            status: req.body.status,
            externalId: req.body.externalId,
        })
    })

    app.delete('/:id', DeleteUserRequest, async (req, res) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        const edition = system.getEdition()
        if (edition === ApEdition.CLOUD) {
            await userService(req.log).removeFromPlatform({
                id: req.params.id,
                platformId,
            })
        }
        else {
            await userService(req.log).delete({
                id: req.params.id,
                platformId,
            })
        }

        return res.status(StatusCodes.NO_CONTENT).send()
    })
}

const ListUsersRequest = {
    schema: {
        querystring: ListUsersRequestBody,
        response: {
            [StatusCodes.OK]: SeekPage(UserWithMetaInformation),
        },
        tags: ['users'],
        description: 'List users',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    response: {
        [StatusCodes.OK]: SeekPage(UserWithMetaInformation),
    },
    config: {
        security: securityAccess.nonEmbedUsersOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

const UpdateUserRequest = {
    schema: {
        params: z.object({
            id: ApId,
        }),
        body: UpdateUserRequestBody,
        response: {
            [StatusCodes.OK]: UserWithMetaInformation,
        },
        tags: ['users'],
        description: 'Update user',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

const DeleteUserRequest = {
    schema: {
        params: z.object({
            id: ApId,
        }),
        tags: ['users'],
        description: 'Delete user',
        response: {
            [StatusCodes.NO_CONTENT]: z.never(),
        },
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}
