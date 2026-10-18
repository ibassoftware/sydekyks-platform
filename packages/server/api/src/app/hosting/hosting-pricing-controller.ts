import { PrincipalType } from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { ManagedSettingsInput, managedSettingsView, saveManagedSettings } from './hosting-managed-settings'
import { createHostedPricing, hostedPricingView, PricingApprovalInput, readApprovedPricing } from './hosting-pricing'
import { PRICING_REFRESH_MS } from './hosting-pricing-source'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingPricingController: FastifyPluginAsyncZod = async app => {
    const dataSource = databaseConnection(), pricing = createHostedPricing({ dataSource })
    const config = { security: securityAccess.unscoped([PrincipalType.USER]) }
    const actorOf = async (request: FastifyRequest): Promise<HostingActor> => {
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_OPERATOR_REQUIRED')
        const principal = request.principal
        return tx.run({ dataSource, fn: async manager => {
            const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
            if (!user) hostingFail('HOSTING_OPERATOR_REQUIRED')
            const actor = { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null }
            await assertHostingOperator({ manager, actor })
            return actor
        } })
    }
    const view = async (actor: HostingActor, platformId?: string) => tx.run({ dataSource, fn: async manager => {
        const user = await assertHostingOperator({ manager, actor })
        const now = await tx.now(manager), settings = await managedSettingsView(manager, platformId), source = await hostedPricingView(manager, now)
        if (settings.effective.managedAvailable && settings.effective.model) {
            try {
                await readApprovedPricing(manager, now, settings.effective.model) 
            }
            catch {
                settings.effective.managedAvailable = false; settings.effective.reason = 'Managed pricing is not currently verified. Refresh the official source and review approval.' 
            }
        }
        return { ...settings, platformId: actor.platformId, userId: user.id, pricing: source }
    } })
    app.addHook('onSend', async (_request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization') 
    })
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HostingError) return reply.code(/REVISION_CONFLICT|IDEMPOTENCY_CONFLICT/.test(error.message) ? 409 : 403).send({ code: error.message })
        throw error
    })
    app.get('/', { config, schema: { querystring: z.strictObject({ platformId: z.string().length(21).optional() }) } }, async request => view(await actorOf(request), request.query.platformId))
    app.post('/settings', { config, bodyLimit: 4096, schema: { body: ManagedSettingsInput } }, async request => {
        const actor = await actorOf(request)
        await saveManagedSettings({ dataSource, actor, input: request.body })
        return view(actor, request.body.platformId)
    })
    app.post('/observe', { config, schema: { body: z.strictObject({}) } }, async request => {
        const actor = await actorOf(request)
        await pricing.observe()
        return view(actor)
    })
    app.post('/approve', { config, schema: { body: PricingApprovalInput } }, async request => {
        const actor = await actorOf(request)
        await pricing.approve({ actor, input: request.body })
        return view(actor)
    })
    // Each API process may schedule this; the durable lease admits one fetcher.
    // A failure is persisted rather than concealing it behind an in-memory cache.
    let timer: ReturnType<typeof setInterval> | undefined, running: Promise<void> | undefined
    const abort = new AbortController()
    const refresh = () => {
        if (running || abort.signal.aborted) return
        running = pricing.observe(abort.signal).catch(() => app.log.error('[managedPricing] Pricing confirmation failed; managed calls remain gated.')).finally(() => {
            running = undefined 
        })
    }
    app.addHook('onReady', async () => {
        refresh(); timer = setInterval(refresh, PRICING_REFRESH_MS); timer.unref() 
    })
    app.addHook('onClose', async () => {
        if (timer) clearInterval(timer); abort.abort(); await running 
    })
}
