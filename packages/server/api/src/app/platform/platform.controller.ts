import { ActivepiecesError, ApId, ErrorCode } from '@activepieces/core-utils'
import { ApEdition, AuthenticationResponse, CreatePlatformRequest, FileType, PlatformWithoutSensitiveData, PrincipalType, SERVICE_KEY_SECURITY_OPENAPI, UpdatePlatformRequestBody } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { fileService } from '../file/file.service'
import { attachMultipartFieldsToBody } from '../helper/multipart-body'
import { system } from '../helper/system/system'
import { userIdentityHelper } from '../helper/user-identity-helper'
import { sydCopilotAvailability } from '../syd/copilot/copilot-availability'
import { userService } from '../user/user-service'
import { platformService } from './platform.service'

const edition = system.getEdition()
export const platformController: FastifyPluginAsyncZod = async (app) => {
    app.post('/', CreatePlatformEndpoint, async (req) => {
        const isOnboarding = req.principal.type === PrincipalType.ONBOARDING
        if (!isOnboarding && edition !== ApEdition.CLOUD) {
            // only first ee/ce user will be able to have onboarding token. which means any other principal type should not be able to create platform
            throw new ActivepiecesError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'This action is unauthorized in non cloud editions',
                },
            })
        }
        const identityId = isOnboarding
            ? req.principal.id
            : (await userService(req.log).getOneOrFail({ id: req.principal.id })).identityId
        const { response } = await platformService(req.log).createPlatformWithProject({
            identityId,
            name: req.body.name,
            invalidatePreviousTokens: isOnboarding,
            isFirstPlatform: isOnboarding,
            callerTokenVersion: req.principal.type === PrincipalType.ONBOARDING ? req.principal.tokenVersion : undefined,
        })
        return response
    })

    app.post('/:id', UpdatePlatformRequest, async (req, _res) => {
        if (req.principal.platform.id !== req.params.id) {
            throw new ActivepiecesError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'You are not authorized to access this platform',
                },
            })
        }
        const platformId = req.principal.platform.id

        const [logoIconUrl, fullLogoUrl, favIconUrl] = await Promise.all([
            fileService(app.log).uploadPublicAsset({
                file: req.body.logoIcon,
                type: FileType.PLATFORM_ASSET,
                platformId,
                metadata: { platformId },
            }),
            fileService(app.log).uploadPublicAsset({
                file: req.body.fullLogo,
                type: FileType.PLATFORM_ASSET,
                platformId,
                metadata: { platformId },
            }),
            fileService(app.log).uploadPublicAsset({
                file: req.body.favIcon,
                type: FileType.PLATFORM_ASSET,
                platformId,
                metadata: { platformId },
            }),
        ])

        await platformService(req.log).update({
            id: platformId,
            ...req.body,
            logoIconUrl,
            fullLogoUrl,
            favIconUrl,
        })
        return platformService(req.log).getOneWithPlanAndUsageOrThrow(platformId)
    })

    app.get('/:id', GetPlatformRequest, async (req) => {
        if (req.principal.platform.id !== req.params.id) {
            throw new ActivepiecesError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'You are not authorized to access this platform',
                },
            })
        }
        const platform = await platformService(req.log).getOneWithPlanAndUsageOrThrow(req.principal.platform.id)
        if (req.principal.type === PrincipalType.USER) {
            const isEmbedded = await userIdentityHelper(req.log).isUserEmbedded(req.principal.id)
            const chatEnabled = sydCopilotAvailability.resolveChatEnabledForUser({ platform, isEmbedded })
            return {
                ...platform,
                plan: {
                    ...platform.plan,
                    chatEnabled,
                    agentsEnabled: sydCopilotAvailability.resolveAgentsEnabledForUser({ platform, isEmbedded }),
                    ...(isEmbedded ? { licenseKey: null } : {}),
                },
            }
        }
        return platform
    })

    app.get('/assets/:id', GetAssetRequest, async (req, reply) => {
        const { fileName, metadata, data } = await fileService(app.log).getDataOrThrow({
            fileId: req.params.id,
            type: [FileType.PLATFORM_ASSET, FileType.USER_PROFILE_PICTURE],
        })

        return reply
            .header(
                'Content-Disposition',
                `attachment; filename="${encodeURI(fileName ?? '')}"`,
            )
            .type(metadata?.mimetype ?? 'application/octet-stream')
            .status(StatusCodes.OK)
            .send(data)
    })



}

const CreatePlatformEndpoint = {
    config: {
        security: securityAccess.unscoped([PrincipalType.ONBOARDING, PrincipalType.USER]),
    },
    schema: {
        body: CreatePlatformRequest,
        response: {
            [StatusCodes.OK]: AuthenticationResponse,
        },
    },
}

const UpdatePlatformRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    preValidation: attachMultipartFieldsToBody,
    schema: {
        body: UpdatePlatformRequestBody,
        params: z.object({
            id: ApId,
        }),
        response: {
            [StatusCodes.OK]: PlatformWithoutSensitiveData,
        },
    },
}


const GetPlatformRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        tags: ['platforms'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Get a platform by id',
        params: z.object({
            id: ApId,
        }),
        response: {
            [StatusCodes.OK]: PlatformWithoutSensitiveData,
        },
    },
}

const GetAssetRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}
