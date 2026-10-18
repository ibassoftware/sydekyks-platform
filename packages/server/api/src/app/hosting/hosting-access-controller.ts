import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { authenticationUtils } from '../authentication/authentication-utils'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { createHostedAccess } from './hosting-access'
import { assertHostingOperator } from './hosting-access-policy'
import { hostingServices } from './hosting-services'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingAccessController: FastifyPluginAsyncZod = async app => {
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    const id = z.string().length(21)
    const assignmentParams = z.strictObject({ platformId: id, identityId: id })
    const service = (): ReturnType<typeof createHostedAccess> => createHostedAccess({ dataSource: databaseConnection() })
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    })
    app.put('/roles/:identityId', { config, schema: { params: z.strictObject({ identityId: id }), body: z.strictObject({ role: z.enum(['partner', 'team']), active: z.boolean() }) } }, async request => {
        await service().setRole({ actor: await actor(request), identityId: request.params.identityId, ...request.body })
        return { success: true }
    })
    app.put('/assignments/:platformId/:identityId', { config, schema: { params: assignmentParams } }, async request => {
        const membership = await service().assignPartner({ actor: await actor(request), ...request.params })
        return { platformId: membership.platformId, identityId: membership.identityId, role: membership.role, active: membership.active }
    })
    app.delete('/assignments/:platformId/:identityId', { config, schema: { params: assignmentParams } }, async request => {
        await service().unassignPartner({ actor: await actor(request), ...request.params })
        return { success: true }
    })
    app.get('/workspaces', { config }, async request => service().list({ actor: await actor(request) }))
    app.post('/workspaces/:platformId/enter', { config, schema: { params: z.strictObject({ platformId: id }) } }, async request => {
        const tenant = await service().enter({ actor: await actor(request), platformId: request.params.platformId })
        return authenticationUtils(request.log).getProjectAndToken({ ...tenant, expectedTokenVersion: tenant.tokenVersion })
    })
    // Creates only the existing idempotent trial/account skeleton. Paid runtime
    // grants require the separate verified enrollment/receipt admission path.
    for (const route of [{ path: '/tenants', requireOwnedHome: false }, { path: '/tenants/owned-home', requireOwnedHome: true }]) {
        app.post(route.path, { config, schema: { body: z.strictObject({ identityId: id, name: z.string().trim().min(1).max(120) }) } }, async request => {
            const operator = await actor(request)
            const onboarding = await hostingServices.onboarding()
            const tenant = await tx.run({ dataSource: databaseConnection(), fn: async manager => {
                await assertHostingOperator({ manager, actor: operator })
                const result = await onboarding.provision({ ...request.body, operator, manager, requireOwnedHome: route.requireOwnedHome })
                await tx.event({ manager, platformId: result.platformId, event: 'operational.tenant.provisioned', payload: { actorIdentityId: operator.identityId, ownerIdentityId: request.body.identityId, created: result.created, requireOwnedHome: route.requireOwnedHome } })
                return result
            } })
            return { platformId: tenant.platformId, userId: tenant.userId, projectId: tenant.projectId, created: tenant.created }
        })
    }
}

async function actor(request: FastifyRequest): Promise<HostingActor> {
    if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_ACCESS_DENIED')
    const user = await databaseConnection().getRepository(UserEntity).findOneBy({ id: request.principal.id, platformId: request.principal.platform.id })
    if (!user) hostingFail('HOSTING_ACCESS_DENIED')
    return { identityId: user.identityId, platformId: request.principal.platform.id, tokenVersion: request.principal.tokenVersion ?? null }
}
