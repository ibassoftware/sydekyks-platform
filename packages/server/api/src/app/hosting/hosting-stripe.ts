import { createHash } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager, IsNull, LessThanOrEqual, Not } from 'typeorm'
import { enrollClientDefaultCourses } from '../lms/lms-client-defaults'
import { hostingResourceFits as resourceFits } from './hosting-billing-resources'
import { hostingConfiguration } from './hosting-configuration'
import { effectiveHostedCredits } from './hosting-credit-allowance'
import { assertClientSubscriptionUser } from './hosting-customer-billing-policy'
import { HostingAccount, HostingAccountEntity, HostingGrant, HostingGrantEntity, HostingLedgerEntity } from './hosting-entities'
import { HostingManualAccountEntity } from './hosting-manual-accounts-entities'
import { createStripeAdapter, PaidPeriodEvidence } from './hosting-stripe-adapter'
import { HostingStripeBindingEntity, HostingStripeCommandEntity, HostingStripeInboxEntity, HostingStripePeriodEntity, StripeBinding, StripeCommand, StripePeriod } from './hosting-stripe-entities'
import { readStripePolicy, stripeDigest, stripeId } from './hosting-stripe-policy'
import { subscriptionAccountUntil } from './hosting-subscription-policy'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.finalization_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded', 'refund.updated', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'credit_note.created', 'credit_note.updated', 'credit_note.voided'])
export async function createHostedStripe({ dataSource }: { dataSource: DataSource }) {
    if (hostingConfiguration.getServiceMode() !== 'hosted') hostingFail('HOSTED_INSTALLATION_REQUIRED')
    // Block before reading Stripe configuration or constructing its network adapter.
    if (hostingConfiguration.getBillingMode() !== 'stripe_test') hostingFail('HOSTING_MANUAL_BILLING_REQUIRED')
    const policy = readStripePolicy()
    const adapter = await createStripeAdapter(policy)
    async function billingMember(manager: EntityManager, actor: HostingActor) {
        const user = await tx.member({ manager, actor, admin: true })
        const account = await manager.getRepository(HostingAccountEntity).findOneByOrFail({ id: actor.platformId })
        assertClientSubscriptionUser(account, user, actor)
        return user
    }
    async function binding(manager: EntityManager, platformId: string): Promise<StripeBinding> {
        const repo = manager.getRepository(HostingStripeBindingEntity)
        let value = await repo.findOneBy({ platformId })
        if (!value) value = await repo.save(repo.create({ id: apId(), platformId, stripeAccountId: policy.catalog.accountId, catalogHash: policy.hash, holds: [], revision: 0, reconcileAt: await tx.now(manager) }))
        if (value.stripeAccountId !== policy.catalog.accountId || value.catalogHash !== policy.hash) hostingFail('HOSTING_STRIPE_BINDING_POLICY_CHANGED')
        return value
    }
    async function assertCheckoutPolicy(manager: EntityManager, account: HostingAccount, bound: StripeBinding, planId: 'starter' | 'team' | 'scale', now: Date): Promise<void> {
        if (await manager.getRepository(HostingManualAccountEntity).existsBy({ id: account.id })) hostingFail('HOSTING_MANUAL_FUNDING_REQUIRES_REVIEW')
        if (hostingCatalog.paidPlans[planId].salesAssisted) hostingFail('HOSTING_STRIPE_SALES_REVIEW_REQUIRED')
        const endedOnly = bound.holds.length === 1 && bound.holds[0] === 'subscription_ended'
        if (account.status === 'suspended' || bound.holds.some(reason => reason !== 'subscription_ended') || (account.billingHold && !endedOnly)) hostingFail('HOSTING_STRIPE_PURCHASE_BLOCKED')
        if (!await resourceFits(manager, account.id, planId, now)) hostingFail('HOSTING_STRIPE_PLAN_RESOURCE_LIMIT')
        if (bound.subscriptionId && (!['canceled', 'incomplete_expired'].includes(bound.subscriptionStatus ?? '') || account.validUntil > now)) hostingFail('HOSTING_STRIPE_SUBSCRIPTION_EXISTS')
    }
    async function assertPlanChange(manager: EntityManager, account: HostingAccount, bound: StripeBinding, planId: 'starter' | 'team' | 'scale', now: Date) {
        if (await manager.getRepository(HostingManualAccountEntity).existsBy({ id: account.id })) hostingFail('HOSTING_MANUAL_FUNDING_REQUIRES_REVIEW')
        if (hostingCatalog.paidPlans[planId].salesAssisted) hostingFail('HOSTING_STRIPE_SALES_REVIEW_REQUIRED')
        if (!['starter', 'team', 'scale'].includes(account.planId) || account.status !== 'active' || account.billingHold || bound.holds.length || bound.subscriptionStatus !== 'active' || !bound.customerId || !bound.subscriptionId || bound.cancelAtPeriodEnd || account.validUntil <= now) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_UNSUPPORTED')
        if (!await resourceFits(manager, account.id, planId, now)) hostingFail('HOSTING_STRIPE_PLAN_RESOURCE_LIMIT')
        const funded = await manager.getRepository(HostingStripePeriodEntity).findOneBy({ platformId: account.id, subscriptionId: bound.subscriptionId, planId: selectedPlan(account.planId), periodEnd: account.validUntil, revokedAt: IsNull() })
        if (!funded || funded.periodEnd.getTime() !== account.validUntil.getTime() || funded.periodStart > now) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_STALE')
    }
    async function command(actor: HostingActor, kind: StripeCommand['kind'], payload: Record<string, unknown>): Promise<StripeCommand> {
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            await billingMember(manager, actor)
            const bound = await binding(manager, account.id)
            const repo = manager.getRepository(HostingStripeCommandEntity)
            let previous = await repo.findOne({ where: { platformId: account.id, kind }, order: { created: 'DESC' } })
            const now = await tx.now(manager)
            if (previous?.state === 'closed') previous = null
            if (kind === 'portal' && previous?.state === 'ready' && previous.expiresAt && previous.expiresAt <= now) {
                await repo.update({ id: previous.id }, { state: 'closed' }); previous = null
            }
            const fullPayload = { catalogHash: policy.hash, ...payload }
            const hash = stripeDigest(fullPayload)
            if (kind === 'checkout') await assertCheckoutPolicy(manager, account, bound, selectedPlan(payload.planId), now)
            if (kind === 'plan_change') await assertPlanChange(manager, account, bound, selectedPlan(payload.planId), now)
            if (previous) {
                if (previous.payloadHash !== hash || previous.actorIdentityId !== actor.identityId || previous.tokenVersion !== (actor.tokenVersion ?? null)) hostingFail('HOSTING_STRIPE_COMMAND_CONFLICT')
                return previous
            }
            const id = apId()
            return repo.save(repo.create({ id, platformId: account.id, kind, state: 'prepared', actorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion ?? null, payload: fullPayload, payloadHash: hash, idempotencyKey: `hosting:test:${policy.catalog.accountId}:${id}` }))
        } })
    }
    async function send(actor: HostingActor, command: StripeCommand): Promise<StripeCommand> {
        const claimed = await tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            await billingMember(manager, actor)
            const bound = await binding(manager, actor.platformId)
            const row = await manager.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id: command.id, platformId: actor.platformId })
            if (row.kind === 'checkout') await assertCheckoutPolicy(manager, account, bound, selectedPlan(row.payload.planId), await tx.now(manager))
            if (row.kind === 'plan_change') await assertPlanChange(manager, account, bound, selectedPlan(row.payload.planId), await tx.now(manager))
            if (row.state === 'ready') return row
            if (row.kind === 'plan_change' && row.state === 'uncertain') hostingFail('HOSTING_STRIPE_COMMAND_RECONCILIATION_REQUIRED')
            if (row.state === 'closed' || row.payloadHash !== stripeDigest(row.payload) || row.payload.catalogHash !== policy.hash || row.actorIdentityId !== actor.identityId || row.tokenVersion !== (actor.tokenVersion ?? null)) hostingFail('HOSTING_STRIPE_COMMAND_CONFLICT')
            const now = await tx.now(manager)
            if ((row.state === 'running' && row.leaseUntil && row.leaseUntil > now) || (row.firstSentAt && now.getTime() - row.firstSentAt.getTime() > 23 * 3600_000)) hostingFail('HOSTING_STRIPE_COMMAND_RECONCILIATION_REQUIRED')
            return manager.getRepository(HostingStripeCommandEntity).save({ ...row, state: 'running', fence: apId(), firstSentAt: row.firstSentAt ?? now, leaseUntil: new Date(now.getTime() + 120_000) })
        } })
        if (claimed.state === 'ready') return deliver(actor, claimed.id)
        let saved: StripeCommand
        try {
            const result = await adapter.create(claimed)
            saved = await tx.run({ dataSource, fn: async manager => {
                await tx.account({ manager, platformId: actor.platformId })
                const bound = await binding(manager, actor.platformId)
                const row = await manager.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id: claimed.id })
                if (row.fence !== claimed.fence || row.state !== 'running') hostingFail('HOSTING_STRIPE_COMMAND_FENCE_MISMATCH')
                const saved = await manager.getRepository(HostingStripeCommandEntity).save({ ...row, ...result, state: 'ready' })
                if (row.kind === 'customer') {
                    if (bound.customerId && bound.customerId !== result.objectId) hostingFail('HOSTING_STRIPE_CUSTOMER_CONFLICT')
                    await manager.getRepository(HostingStripeBindingEntity).save({ ...bound, customerId: result.objectId, reconcileAt: await tx.now(manager), revision: bound.revision + 1 })
                }
                else if (row.kind === 'plan_change') await manager.getRepository(HostingStripeBindingEntity).update({ id: bound.id }, { pendingPlanId: selectedPlan(row.payload.planId), pendingChangeAt: new Date(String(row.payload.effectiveAt)), reconcileAt: await tx.now(manager), revision: bound.revision + 1 })
                else await manager.getRepository(HostingStripeBindingEntity).update({ id: bound.id }, { reconcileAt: await tx.now(manager) })
                await tx.event({ manager, platformId: row.platformId, event: `stripe.${row.kind}.created`, payload: { commandId: row.id, objectId: result.objectId } })
                return saved
            } })
        }
        catch {
            await tx.run({ dataSource, fn: async manager => {
                await tx.account({ manager, platformId: actor.platformId })
                await manager.getRepository(HostingStripeCommandEntity).update({ id: claimed.id, fence: claimed.fence ?? '', state: 'running' }, { state: 'uncertain' })
            } })
            hostingFail('HOSTING_STRIPE_COMMAND_OUTCOME_UNKNOWN')
        }
        return deliver(actor, saved.id)
    }
    async function deliver(actor: HostingActor, commandId: string): Promise<StripeCommand> {
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            await billingMember(manager, actor)
            const row = await manager.getRepository(HostingStripeCommandEntity).findOneByOrFail({ id: commandId, platformId: actor.platformId })
            if (row.kind === 'checkout') await assertCheckoutPolicy(manager, account, await binding(manager, actor.platformId), selectedPlan(row.payload.planId), await tx.now(manager))
            if (row.state !== 'ready' || row.actorIdentityId !== actor.identityId || row.tokenVersion !== (actor.tokenVersion ?? null)) hostingFail('HOSTING_ACCESS_DENIED')
            if (row.kind !== 'customer' && (!row.expiresAt || row.expiresAt <= await tx.now(manager))) hostingFail('HOSTING_STRIPE_SESSION_EXPIRED')
            return row
        } })
    }
    async function customer(actor: HostingActor): Promise<string> {
        const existing = await tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId: actor.platformId }); await billingMember(manager, actor)
            if (await manager.getRepository(HostingManualAccountEntity).existsBy({ id: actor.platformId })) hostingFail('HOSTING_MANUAL_FUNDING_REQUIRES_REVIEW')
            return (await binding(manager, actor.platformId)).customerId
        } })
        if (existing) return existing
        const result = await send(actor, await command(actor, 'customer', {}))
        if (!result.objectId) hostingFail('HOSTING_STRIPE_CUSTOMER_UNAVAILABLE')
        return result.objectId
    }
    async function checkout(actor: HostingActor, planId: 'starter' | 'team' | 'scale') {
        const customerId = await customer(actor)
        const previous = await dataSource.getRepository(HostingStripeCommandEntity).findOne({ where: { platformId: actor.platformId, kind: 'checkout', state: 'ready' }, order: { created: 'DESC' } })
        if (previous?.objectId && previous.expiresAt && previous.expiresAt <= new Date()) {
            const current = await adapter.checkout(previous.objectId, customerId)
            await tx.run({ dataSource, fn: async manager => {
                await tx.account({ manager, platformId: actor.platformId }); await billingMember(manager, actor)
                if (current.status === 'expired') await manager.getRepository(HostingStripeCommandEntity).update({ id: previous.id, state: 'ready' }, { state: 'closed' })
            } })
            if (current.status !== 'expired') hostingFail('HOSTING_STRIPE_PURCHASE_RECONCILIATION_REQUIRED')
        }
        const result = await send(actor, await command(actor, 'checkout', { customerId, planId }))
        return { commandId: result.id, url: result.url, expiresAt: result.expiresAt?.toISOString() ?? null }
    }
    async function portal(actor: HostingActor) {
        const customerId = await customer(actor)
        const result = await send(actor, await command(actor, 'portal', { customerId }))
        return { commandId: result.id, url: result.url, deliveryUntil: result.expiresAt?.toISOString() ?? null }
    }
    async function changePlan(actor: HostingActor, planId: 'starter' | 'team' | 'scale') {
        selectedPlan(planId)
        const payload = await tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            const user = await billingMember(manager, actor)
            const bound = await binding(manager, account.id)
            await assertPlanChange(manager, account, bound, planId, await tx.now(manager))
            const open = await manager.getRepository(HostingStripeCommandEntity).findOne({ where: { platformId: account.id, kind: 'plan_change', state: Not('closed') } })
            if (open && open.payload.planId !== planId) hostingFail('HOSTING_STRIPE_COMMAND_CONFLICT')
            if (open && ['running', 'uncertain'].includes(open.state)) hostingFail('HOSTING_STRIPE_COMMAND_RECONCILIATION_REQUIRED')
            return { userId: user.id, customerId: bound.customerId!, subscriptionId: bound.subscriptionId!, planId, effectiveAt: account.validUntil.toISOString(), alreadySelected: !open && (bound.pendingPlanId === planId || (!bound.pendingPlanId && account.planId === planId)) }
        } })
        if (payload.alreadySelected) return { platformId: actor.platformId, userId: payload.userId, planId, effectiveAt: payload.effectiveAt, timing: 'next_renewal' as const }
        const { alreadySelected: _alreadySelected, userId: _userId, ...commandPayload } = payload
        const result = await send(actor, await command(actor, 'plan_change', commandPayload))
        await tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId: actor.platformId }); await billingMember(manager, actor)
            await manager.getRepository(HostingStripeCommandEntity).update({ id: result.id, platformId: actor.platformId, state: 'ready' }, { state: 'closed' })
        } })
        return { platformId: actor.platformId, userId: payload.userId, commandId: result.id, planId, effectiveAt: payload.effectiveAt, timing: 'next_renewal' as const }
    }
    async function ingest(raw: string, signature: string): Promise<void> {
        const event = adapter.verify(raw, signature)
        const rawHash = createHash('sha256').update(raw).digest('hex')
        const eventHash = stripeDigest({ id: event.id, type: event.type, created: event.created, api_version: event.api_version, livemode: event.livemode, data: event.data })
        const object = event.data.object
        const customerId = 'customer' in object ? stripeId(object.customer) : null
        const chargeId = 'charge' in object ? stripeId(object.charge) : event.type === 'charge.refunded' && 'id' in object ? String(object.id) : null
        const risk = (event.type.startsWith('charge.dispute.') && 'status' in object && !['won', 'warning_closed'].includes(String(object.status))) || (event.type === 'charge.refunded' && 'refunded' in object && object.refunded === true)
        await tx.run({ dataSource, fn: async manager => {
            const repo = manager.getRepository(HostingStripeInboxEntity)
            const supported = EVENTS.has(event.type)
            await repo.createQueryBuilder().insert().values({ id: apId(), stripeAccountId: policy.catalog.accountId, eventId: event.id, eventType: event.type, rawHash, eventHash, objectId: 'id' in object && typeof object.id === 'string' ? object.id : null, customerId, chargeId, risk, state: supported ? 'pending' : 'ignored', availableAt: await tx.now(manager), reason: supported ? null : 'unsupported_event' }).orIgnore().execute()
            const stored = await repo.findOneByOrFail({ stripeAccountId: policy.catalog.accountId, eventId: event.id })
            if (stored.eventHash !== eventHash) hostingFail('HOSTING_STRIPE_EVENT_CONFLICT')
            if (supported && stored.state === 'pending') {
                const bound = await route(manager, stored.customerId, stored.chargeId)
                if (bound) {
                    await tx.account({ manager, platformId: bound.platformId })
                    await dirty({ manager, bound: await binding(manager, bound.platformId), reason: 'webhook_pending', risk: await riskHold(manager, stored) })
                }
            }
        } })
    }
    async function dirty({ manager, bound, reason, risk = false }: { manager: EntityManager, bound: StripeBinding, reason: string, risk?: boolean }) {
        if (risk) await manager.getRepository(HostingAccountEntity).update({ id: bound.platformId }, { billingHold: true })
        await manager.getRepository(HostingStripeBindingEntity).save({ ...bound, holds: risk ? [...new Set([...bound.holds, reason])] : bound.holds, revision: bound.revision + 1, reconcileAt: await tx.now(manager) })
    }
    async function route(manager: EntityManager, customerId: string | null, chargeId: string | null): Promise<StripeBinding | null> {
        if (!customerId && chargeId) {
            const period = await manager.getRepository(HostingStripePeriodEntity).createQueryBuilder('period').where('period."stripeAccountId" = :accountId AND period."chargeIds" @> CAST(:charge AS jsonb)', { accountId: policy.catalog.accountId, charge: JSON.stringify([chargeId]) }).getOne()
            customerId = period?.customerId ?? null
        }
        return customerId ? manager.getRepository(HostingStripeBindingEntity).findOneBy({ stripeAccountId: policy.catalog.accountId, customerId }) : null
    }
    async function riskHold(manager: EntityManager, event: { risk: boolean, eventType: string, chargeId: string | null }): Promise<boolean> {
        if (!event.risk || event.eventType !== 'charge.refunded' || !event.chargeId) return event.risk
        const period = await manager.getRepository(HostingStripePeriodEntity).createQueryBuilder('period').where('period."stripeAccountId" = :accountId AND period."chargeIds" @> CAST(:charge AS jsonb)', { accountId: policy.catalog.accountId, charge: JSON.stringify([event.chargeId]) }).getOne()
        // An expired funded period cannot authorize new work. Its refund must not hold a separately paid current period.
        return !period || period.periodEnd > await tx.now(manager)
    }
    async function processInbox(): Promise<void> {
        const due = await dataSource.getRepository(HostingStripeInboxEntity).find({ where: { state: 'pending', availableAt: LessThanOrEqual(new Date()) }, take: 10, order: { availableAt: 'ASC', id: 'ASC' } })
        for (const row of due) {
            const claim = await tx.run({ dataSource, fn: async manager => {
                const current = await manager.getRepository(HostingStripeInboxEntity).findOne({ where: { id: row.id }, lock: { mode: 'pessimistic_write' } })
                if (!current || current.state !== 'pending' || current.availableAt > await tx.now(manager)) return false
                await manager.getRepository(HostingStripeInboxEntity).update({ id: row.id }, { availableAt: new Date((await tx.now(manager)).getTime() + 60_000) })
                return true
            } })
            if (!claim) continue
            try {
                const known = await route(dataSource.manager, row.customerId, row.chargeId)
                const customerId = known?.customerId ?? row.customerId ?? await adapter.eventCustomer(row.eventId)
                await tx.run({ dataSource, fn: async manager => {
                    const bound = customerId ? await manager.getRepository(HostingStripeBindingEntity).findOneBy({ stripeAccountId: policy.catalog.accountId, customerId }) : null
                    if (bound) {
                        await tx.account({ manager, platformId: bound.platformId }); await dirty({ manager, bound: await binding(manager, bound.platformId), reason: 'webhook_pending', risk: await riskHold(manager, row) })
                    }
                    await manager.getRepository(HostingStripeInboxEntity).update({ id: row.id }, { customerId, state: bound ? 'processed' : 'quarantined', reason: bound ? null : 'unbound_customer' })
                } })
            }
            catch { /* Keep pending. A failed read never supplies entitlement authority. */ }
        }
    }
    async function reconcile(platformId: string): Promise<void> {
        const claim = await tx.run({ dataSource, fn: async manager => {
            await tx.account({ manager, platformId })
            const bound = await binding(manager, platformId)
            const now = await tx.now(manager)
            if (!bound.customerId || (bound.leaseUntil && bound.leaseUntil > now)) {
                await manager.getRepository(HostingStripeBindingEntity).update({ id: bound.id }, { reconcileAt: bound.leaseUntil && bound.leaseUntil > now ? bound.leaseUntil : new Date(now.getTime() + 300_000) })
                return null
            }
            const periods = await manager.getRepository(HostingStripePeriodEntity).findBy({ platformId })
            if (periods.length > 128) {
                await manager.getRepository(HostingStripeBindingEntity).update({ id: bound.id }, { lastError: 'HOSTING_STRIPE_RECONCILIATION_LIMIT', reconcileAt: new Date(now.getTime() + 300_000) })
                return null
            }
            const saved = await manager.getRepository(HostingStripeBindingEntity).save({ ...bound, fence: apId(), leaseUntil: new Date(now.getTime() + 600_000), reconcileAt: new Date(now.getTime() + 300_000) })
            return { bound: saved, chargeIds: [...new Set(periods.flatMap(value => value.chargeIds))] }
        } })
        if (!claim?.bound.customerId) return
        try {
            const observed = await adapter.snapshot({ customerId: claim.bound.customerId, previousSubscriptionId: claim.bound.subscriptionId, chargeIds: claim.chargeIds })
            await tx.run({ dataSource, fn: async manager => {
                const account = await tx.account({ manager, platformId })
                const bound = await binding(manager, platformId)
                if (bound.fence !== claim.bound.fence || bound.revision !== claim.bound.revision || !bound.leaseUntil || bound.leaseUntil <= await tx.now(manager)) hostingFail('HOSTING_STRIPE_RECONCILIATION_FENCE_MISMATCH')
                const issues = [...observed.issues]
                if (observed.customerPlatformId !== platformId || (!issues.length && observed.subscriptionId && observed.subscriptionPlatformId !== platformId)) issues.push('HOSTING_STRIPE_OBJECT_MISMATCH')
                if (!issues.length && observed.subscriptionId) {
                    const purchase = observed.commandId ? await manager.getRepository(HostingStripeCommandEntity).findOneBy({ id: observed.commandId, platformId, kind: 'checkout' }) : null
                    const recorded = observed.period ? await manager.getRepository(HostingStripePeriodEntity).findOneBy({ platformId, subscriptionId: observed.period.subscriptionId, itemId: observed.period.itemId, priceId: observed.period.priceId, planId: observed.period.planId, periodStart: new Date(observed.period.start * 1000), periodEnd: new Date(observed.period.end * 1000) }) : null
                    const recordedEvidence = !!recorded && recorded.customerId === bound.customerId && !!observed.period && recorded.invoiceIds.includes(observed.period.invoiceId) && recorded.lineIds.includes(observed.period.lineId) && recorded.chargeIds.includes(observed.period.chargeId)
                    let planAuthorized = !observed.period || recordedEvidence || purchase?.payload.planId === observed.period.planId
                    if (!planAuthorized && observed.period && 'planChangeCommandId' in observed && observed.planChangeCommandId) {
                        const change = await manager.getRepository(HostingStripeCommandEntity).findOneBy({ id: observed.planChangeCommandId, platformId, kind: 'plan_change' })
                        planAuthorized = !!change && !!change.firstSentAt && ['running', 'uncertain', 'ready', 'closed'].includes(change.state) && change.payloadHash === stripeDigest(change.payload) && change.payload.customerId === bound.customerId && change.payload.subscriptionId === observed.subscriptionId && change.payload.planId === observed.period.planId && Date.parse(String(change.payload.effectiveAt)) <= observed.period.start * 1000
                    }
                    if (!purchase || !['running', 'uncertain', 'ready', 'closed'].includes(purchase.state) || purchase.payload.customerId !== bound.customerId || !planAuthorized) issues.push('HOSTING_STRIPE_SUBSCRIPTION_UNBOUND')
                    if (bound.subscriptionId && bound.subscriptionId !== observed.subscriptionId && !['canceled', 'incomplete_expired'].includes(bound.subscriptionStatus ?? '')) issues.push('HOSTING_STRIPE_SUBSCRIPTION_CONFLICT')
                }
                if (!issues.length && observed.period) {
                    try {
                        await recordPeriod({ manager, bound, evidence: observed.period })
                    }
                    catch (error) {
                        if (!(error instanceof HostingError)) throw error; issues.push(error.message)
                    }
                }
                const periods = await manager.getRepository(HostingStripePeriodEntity).findBy({ platformId })
                const now = await tx.now(manager)
                for (const period of periods) {
                    if (period.chargeIds.some(id => observed.charges.some(charge => charge.id === id && (charge.refunded || charge.lost)))) await revokePeriod({ manager, period, now })
                }
                // A provider-confirmed selection also resolves an unknown
                // update that restored the current plan, or crossed renewal.
                // Closing delivery supplies no new funding authority.
                if (!issues.length && 'planChangeCommandId' in observed && observed.planChangeCommandId && 'selectedPlanId' in observed && observed.selectedPlanId) {
                    const selected = await manager.getRepository(HostingStripeCommandEntity).findOneBy({ id: observed.planChangeCommandId, platformId, kind: 'plan_change' })
                    if (!selected || !selected.firstSentAt || !['running', 'uncertain', 'ready', 'closed'].includes(selected.state) || selected.payloadHash !== stripeDigest(selected.payload) || selected.payload.customerId !== bound.customerId || selected.payload.subscriptionId !== observed.subscriptionId || selected.payload.planId !== observed.selectedPlanId) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_UNVERIFIED')
                    if (selected.state !== 'running' || !selected.leaseUntil || selected.leaseUntil <= await tx.now(manager)) await manager.getRepository(HostingStripeCommandEntity).update({ id: selected.id }, { state: 'closed', objectId: observed.subscriptionId, expiresAt: new Date(String(selected.payload.effectiveAt)), leaseUntil: null })
                }
                const pendingPlan = 'pendingPlan' in observed ? observed.pendingPlan : null
                if (pendingPlan) {
                    const change = await manager.getRepository(HostingStripeCommandEntity).findOneBy({ id: pendingPlan.commandId, platformId, kind: 'plan_change' })
                    if (!change || !change.firstSentAt || !['running', 'uncertain', 'ready', 'closed'].includes(change.state) || change.payloadHash !== stripeDigest(change.payload) || change.payload.planId !== pendingPlan.planId || change.payload.subscriptionId !== observed.subscriptionId || Date.parse(String(change.payload.effectiveAt)) !== pendingPlan.effectiveAt * 1000) hostingFail('HOSTING_STRIPE_PLAN_CHANGE_UNVERIFIED')
                    if (!issues.length && (change.state !== 'running' || !change.leaseUntil || change.leaseUntil <= await tx.now(manager))) await manager.getRepository(HostingStripeCommandEntity).update({ id: change.id }, { state: 'closed', objectId: observed.subscriptionId, expiresAt: new Date(pendingPlan.effectiveAt * 1000), leaseUntil: null })
                }
                const allPeriods = await manager.getRepository(HostingStripePeriodEntity).findBy({ platformId })
                const current = allPeriods.filter(value => value.periodStart <= now && value.periodEnd > now).sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime())[0]
                const transient = issues.some(value => ['HOSTING_STRIPE_READ_FAILED', 'HOSTING_STRIPE_RECONCILIATION_DEADLINE'].includes(value))
                const holds = [...(transient ? bound.holds : []), ...observed.charges.flatMap(value => value.holds), ...issues.filter(value => !['HOSTING_STRIPE_READ_FAILED', 'HOSTING_STRIPE_RECONCILIATION_DEADLINE', 'HOSTING_STRIPE_PAYMENT_REQUIRED'].includes(value))]
                if (current) {
                    if (account.planId === 'trial') {
                        const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId })
                        for (const grant of grants.filter(value => value.sourceKey.startsWith('trial:'))) await revokeGrant({ manager, grant, now })
                    }
                    if (!await resourceFits(manager, platformId, current.planId, now)) holds.push('resource_limits')
                    if (current.revokedAt) holds.push('current_period_revoked')
                    await manager.getRepository(HostingAccountEntity).update({ id: platformId }, { planId: current.planId, validUntil: current.periodEnd, catalogVersion: hostingCatalog.version, ...(account.status === 'trialing' ? { status: 'active' as const } : {}) })
                    if (!current.revokedAt && holds.length === 0) await enrollClientDefaultCourses(manager, { platformId, enrolledBy: account.ownerIdentityId, now })
                }
                if (observed.subscriptionStatus === 'canceled' && !current && now >= subscriptionAccountUntil(account)) holds.push('subscription_ended')
                await manager.getRepository(HostingAccountEntity).update({ id: platformId }, { billingHold: holds.length > 0 })
                await manager.getRepository(HostingStripeBindingEntity).save({ ...bound, ...(!issues.length ? { subscriptionId: observed.subscriptionId, subscriptionStatus: observed.subscriptionStatus, pendingPlanId: pendingPlan?.planId ?? null, pendingChangeAt: pendingPlan ? new Date(pendingPlan.effectiveAt * 1000) : null, cancelAtPeriodEnd: 'cancelAtPeriodEnd' in observed ? observed.cancelAtPeriodEnd : false } : {}), lastError: issues.join(',') || null, holds: [...new Set(holds)], fence: null, leaseUntil: null, reconcileAt: new Date(now.getTime() + 300_000) })
                if (!issues.length && observed.subscriptionId && observed.commandId) await manager.getRepository(HostingStripeCommandEntity).update({ id: observed.commandId, platformId, kind: 'checkout' }, { state: 'closed' })
                await tx.event({ manager, platformId, event: 'stripe.reconciled', payload: { subscriptionId: observed.subscriptionId, billingHold: holds.length > 0 } })
            } })
        }
        catch (error) {
            await tx.run({ dataSource, fn: async manager => {
                await tx.account({ manager, platformId })
                const bound = await binding(manager, platformId)
                if (bound.fence !== claim.bound.fence) return
                const reason = error instanceof HostingError ? error.message : 'HOSTING_STRIPE_READ_FAILED'
                const transient = !(error instanceof HostingError) || ['HOSTING_STRIPE_READ_FAILED', 'HOSTING_STRIPE_RECONCILIATION_FENCE_MISMATCH'].includes(reason)
                if (!transient) await manager.getRepository(HostingAccountEntity).update({ id: platformId }, { billingHold: true })
                await manager.getRepository(HostingStripeBindingEntity).save({ ...bound, lastError: reason, holds: transient ? bound.holds : [...new Set([...bound.holds, reason])], leaseUntil: null, fence: null, reconcileAt: new Date((await tx.now(manager)).getTime() + 60_000) })
            } })
        }
    }
    async function recover(): Promise<void> {
        await processInbox()
        const due = await dataSource.getRepository(HostingStripeBindingEntity).find({ where: { reconcileAt: LessThanOrEqual(new Date()) }, order: { reconcileAt: 'ASC', id: 'ASC' }, take: 5 })
        for (const bound of due) {
            try {
                await reconcile(bound.platformId)
            }
            catch {
                await dataSource.getRepository(HostingStripeBindingEntity).update({ id: bound.id }, { reconcileAt: new Date(Date.now() + 300_000) })
            }
        }
    }
    async function status(actor: HostingActor) {
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId }); await billingMember(manager, actor)
            const bound = await manager.getRepository(HostingStripeBindingEntity).findOneBy({ platformId: actor.platformId })
            return { environment: 'test', planId: account.planId, status: account.status, validUntil: account.validUntil.toISOString(), trialEndsAt: account.trialEndsAt.toISOString(), billingHold: account.billingHold ?? false, billingReasons: bound?.holds ?? [], lastBillingError: bound?.lastError ?? null, subscriptionStatus: bound?.subscriptionStatus ?? null, planChangesEnabled: ['starter', 'team', 'scale'].includes(account.planId) && account.status === 'active' && !account.billingHold && !!bound?.subscriptionId && bound.subscriptionStatus === 'active' && !bound.cancelAtPeriodEnd && bound.holds.length === 0 && !await manager.getRepository(HostingManualAccountEntity).existsBy({ id: account.id }) }
        } })
    }
    return { checkout, portal, changePlan, ingest, recover, status }
}

async function recordPeriod({ manager, bound, evidence }: { manager: EntityManager, bound: StripeBinding, evidence: PaidPeriodEvidence }): Promise<void> {
    const sourceKey = `stripe:${stripeDigest([bound.stripeAccountId, evidence.subscriptionId, evidence.itemId, evidence.start, evidence.end])}`
    const repo = manager.getRepository(HostingStripePeriodEntity)
    const all = await repo.findBy({ platformId: bound.platformId })
    const existing = all.find(value => value.sourceKey === sourceKey)
    if (!existing && all.length >= 128) hostingFail('HOSTING_STRIPE_RECONCILIATION_LIMIT')
    const start = new Date(evidence.start * 1000), end = new Date(evidence.end * 1000)
    if (all.some(value => value.sourceKey !== sourceKey && value.periodStart < end && value.periodEnd > start)) hostingFail('HOSTING_STRIPE_PERIOD_OVERLAP')
    if (all.some(value => value.sourceKey !== sourceKey && (value.invoiceIds.includes(evidence.invoiceId) || value.lineIds.includes(evidence.lineId) || value.chargeIds.includes(evidence.chargeId)))) hostingFail('HOSTING_STRIPE_PAYMENT_REUSED')
    if (existing && (existing.planId !== evidence.planId || existing.priceId !== evidence.priceId || existing.customerId !== bound.customerId)) hostingFail('HOSTING_STRIPE_PERIOD_CONFLICT')
    if (existing && (existing.invoiceIds.length > 100 || existing.lineIds.length > 100 || existing.chargeIds.length > 100)) hostingFail('HOSTING_STRIPE_EVIDENCE_LIMIT')
    await repo.save(repo.create({ ...existing, id: existing?.id ?? apId(), platformId: bound.platformId, stripeAccountId: bound.stripeAccountId, customerId: bound.customerId ?? '', subscriptionId: evidence.subscriptionId, itemId: evidence.itemId, priceId: evidence.priceId, planId: evidence.planId, sourceKey, periodStart: start, periodEnd: end, invoiceIds: [...new Set([...(existing?.invoiceIds ?? []), evidence.invoiceId])], lineIds: [...new Set([...(existing?.lineIds ?? []), evidence.lineId])], chargeIds: [...new Set([...(existing?.chargeIds ?? []), evidence.chargeId])] }))
    if (existing) return
    const credits = await effectiveHostedCredits(manager, bound.platformId, evidence.planId)
    for (const [meter, amount] of [['execution', BigInt(credits)], ['managed_ai', 0n]] as const) {
        const id = apId()
        await manager.getRepository(HostingGrantEntity).insert({ id, platformId: bound.platformId, sourceKey, meter, amount, consumed: 0n, reserved: 0n, validFrom: start, validUntil: end })
        await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: bound.platformId, grantId: id, reservationId: null, operation: 'grant', key: `grant:${id}`, amount })
    }
}
async function revokePeriod({ manager, period, now }: { manager: EntityManager, period: StripePeriod, now: Date }): Promise<void> {
    if (period.revokedAt) return
    const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId: period.platformId, sourceKey: period.sourceKey })
    for (const grant of grants) await revokeGrant({ manager, grant, now })
    await manager.getRepository(HostingStripePeriodEntity).update({ id: period.id }, { revokedAt: now })
    await tx.event({ manager, platformId: period.platformId, event: 'stripe.period_revoked', payload: { periodId: period.id } })
}
async function revokeGrant({ manager, grant, now }: { manager: EntityManager, grant: HostingGrant, now: Date }): Promise<void> {
    if (grant.revokedAt) return
    const remaining = grant.amount - grant.consumed - grant.reserved
    await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { revokedAt: now })
    await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: grant.platformId, grantId: grant.id, reservationId: null, operation: 'revoke', key: `revoke:${grant.id}`, amount: remaining > 0n ? remaining : 0n })
}

function selectedPlan(value: unknown): 'starter' | 'team' | 'scale' {
    if (value !== 'starter' && value !== 'team' && value !== 'scale') hostingFail('HOSTING_STRIPE_PRICE_DENIED')
    return value
}
