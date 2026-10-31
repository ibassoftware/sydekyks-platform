import { PrincipalType } from '@activepieces/shared'
import { FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { hostingConfiguration } from './hosting-configuration'
import { HostingError, hostingFail } from './hosting-transactions'

// Hosted workspace owners are tenant admins, not administrators of shared infra.
// Retain the existing platform-admin security check for self-hosted installations.
export async function requireHostedInfrastructureOperator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    void reply.header('Cache-Control', 'private, no-store')
    try {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_OPERATOR_REQUIRED')
        const principal = request.principal
        const database = databaseConnection()
        const user = await database.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
        if (!user) hostingFail('HOSTING_OPERATOR_REQUIRED')
        await assertHostingOperator({ manager: database.manager, actor: { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null } })
    }
    catch (error) {
        if (!(error instanceof HostingError)) throw error
        void reply.code(StatusCodes.FORBIDDEN).send({ code: 'HOSTING_OPERATOR_REQUIRED' })
    }
}
