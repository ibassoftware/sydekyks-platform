import { ActivepiecesError, ErrorCode, isNil } from '@activepieces/core-utils'
import { Principal, PrincipalType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { accessTokenManager } from '../../../../authentication/lib/access-token-manager'

export const authenticateOrThrow = async (log: FastifyBaseLogger, rawToken: string | null): Promise<Principal> => {
    if (!isNil(rawToken) && rawToken.startsWith('Bearer sk-')) {
        throw new ActivepiecesError({ code: ErrorCode.AUTHENTICATION, params: { message: 'Service API keys are not enabled in this build.' } })
    }
    if (!isNil(rawToken) && rawToken.startsWith('Bearer ')) {
        const trimBearerPrefix = rawToken.replace('Bearer ', '')
        const principal = await accessTokenManager(log).verifyPrincipal(trimBearerPrefix)
        if (principal.type === PrincipalType.SERVICE) {
            throw new ActivepiecesError({ code: ErrorCode.AUTHENTICATION, params: { message: 'Service principals are not enabled in this build.' } })
        }
        return principal
    }
    return {
        id: nanoid(),
        type: PrincipalType.UNKNOWN,
    }
}
