import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { authnRateLimit } from '../core/security/rate-limit'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { HostedAiQuote } from './hosting-ai-policy'
import { ChargeResolutionCommand, ChargeResolutionDraft, createHostedChargeResolution } from './hosting-charge-resolution'
import { HostingActor, HostingError, hostingFail } from './hosting-transactions'

const quantity = z.string().regex(/^\d+$/), id = z.string().length(21)
const identity = z.strictObject({ userId: id, identityId: id, platformId: id, tokenVersion: z.string().nullable() })
const projection = z.strictObject({ expectedRevision: z.number().int(), expectedState: z.string(), actualMicroUsd: quantity.nullable(), actualCredits: quantity.nullable(), releasedCredits: quantity, releasedSupplierMicroUsd: quantity, rootWillSettle: z.boolean(), blockers: z.array(z.string()) })
export const ChargeResolutionView = z.strictObject({
    nativeTool: z.enum(['search', 'fetch']).nullable(), toolUnitPriceMicroUsd: quantity.nullable(), toolTariffVersion: z.string().nullable(), identity, callId: id, platformId: id, projectId: id, callKey: z.string(), attempt: z.number().int(), requestHash: z.string(), model: z.string(), endpoint: z.string(), sentAt: z.iso.datetime().nullable(), budgetDay: z.string().nullable(), quote: HostedAiQuote.nullable(), rootReservationId: id,
    payer: z.enum(['managed', 'byok']), state: z.enum(['prepared', 'running', 'settled', 'uncertain', 'cancelled']), revision: z.number().int(), stateHash: z.string(), heldCredits: quantity, heldSupplierMicroUsd: quantity, accountingVersion: z.string(), microUsdPerCredit: quantity, leaseUntil: z.iso.datetime(), canResolve: z.boolean(), blockers: z.array(z.string()),
    history: z.array(z.strictObject({ id, revision: z.number().int(), created: z.iso.datetime(), outcome: z.enum(['verified_usage', 'confirmed_not_sent', 'retain']), reason: z.string(), evidenceReference: z.string(), supplierRequestId: z.string().nullable(), operatorIdentityId: id, result: z.record(z.string(), z.unknown()) })),
})

export const hostingChargeResolutionController: FastifyPluginAsyncZod = async app => {
    const dataSource = databaseConnection(), service = createHostedChargeResolution({ dataSource })
    const config = { security: securityAccess.unscoped([PrincipalType.USER]), rateLimit: authnRateLimit }
    const actorOf = async (request: FastifyRequest): Promise<HostingActor> => {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_OPERATOR_REQUIRED')
        const user = await dataSource.getRepository(UserEntity).findOneBy({ id: request.principal.id, platformId: request.principal.platform.id })
        if (!user) hostingFail('HOSTING_OPERATOR_REQUIRED')
        return { identityId: user.identityId, platformId: request.principal.platform.id, tokenVersion: request.principal.tokenVersion ?? null }
    }
    const params = z.strictObject({ callId: z.string().length(21) }), querystring = z.strictObject({ platformId: z.string().length(21) })
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('Vary', 'Authorization') 
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(/CONFLICT/.test(error.message) ? 409 : 403).send({ code: error.message })
        return reply.code(400).send({ code: 'HOSTING_CHARGE_RESOLUTION_INVALID' })
    })
    app.get('/', { config, schema: { querystring, response: { 200: z.strictObject({ identity, platformId: id, calls: z.array(ChargeResolutionView), hasMore: z.boolean() }) } } }, async request => service.list({ actor: await actorOf(request), platformId: request.query.platformId }))
    app.get('/:callId', { config, schema: { params, querystring, response: { 200: ChargeResolutionView } } }, async request => service.read({ actor: await actorOf(request), platformId: request.query.platformId, callId: request.params.callId }))
    app.post('/:callId/preview', { config, logLevel: 'silent', bodyLimit: 8192, schema: { params, body: ChargeResolutionDraft, response: { 200: z.strictObject({ view: ChargeResolutionView, preview: projection }) } } }, async request => service.preview({ actor: await actorOf(request), callId: request.params.callId, input: request.body }))
    app.post('/:callId/resolve', { config, logLevel: 'silent', bodyLimit: 8192, schema: { params, body: ChargeResolutionCommand, response: { 200: z.strictObject({ view: ChargeResolutionView, replayed: z.boolean(), auditId: id }) } } }, async request => service.resolve({ actor: await actorOf(request), callId: request.params.callId, input: request.body }))
}
