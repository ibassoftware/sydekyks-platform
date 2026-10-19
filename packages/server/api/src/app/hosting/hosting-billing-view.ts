import { HostedBillingActionReason, HostedBillingOverview, hostingCatalog } from '@activepieces/shared'
import { DataSource, Not } from 'typeorm'
import { effectiveManagedAiCredits } from './hosting-ai-allowance'
import { hostingResourceUsage } from './hosting-billing-resources'
import { hostingConfiguration } from './hosting-configuration'
import { HostingGrant, HostingGrantEntity } from './hosting-entities'
import { hostingGrantMatchesPlan } from './hosting-plan-grants'
import { HostingStripeBindingEntity, HostingStripeCommandEntity, StripeCommand } from './hosting-stripe-entities'
import { readStripePolicy, stripeDigest } from './hosting-stripe-policy'
import { subscriptionAccountActive, subscriptionAccountUntil, subscriptionGrantActive, subscriptionGrantUntil } from './hosting-subscription-policy'
import { HostingActor, hostingTransactions as tx } from './hosting-transactions'

export function createHostedBillingView({ dataSource }: { dataSource: DataSource }) {
    return { async read(actor: HostingActor): Promise<HostedBillingOverview> {
        return tx.run({ dataSource, fn: async manager => {
            const account = await tx.account({ manager, platformId: actor.platformId })
            const user = await tx.member({ manager, actor, admin: true })
            const now = await tx.now(manager)
            const bound = await manager.getRepository(HostingStripeBindingEntity).findOneBy({ platformId: account.id })
            const commands = await manager.getRepository(HostingStripeCommandEntity).findBy({ platformId: account.id, state: Not('closed') })
            const open = commands.filter(value => value.state !== 'closed')
            const usage = await hostingResourceUsage(manager, account.id, now)
            const grants = await manager.getRepository(HostingGrantEntity).find({ where: { platformId: account.id }, order: { validFrom: 'DESC', id: 'ASC' } })
            const candidates = grants.filter(value => value.meter === 'execution' && hostingGrantMatchesPlan(value, account.planId) && value.validFrom <= now)
            const current = candidates.find(value => subscriptionGrantActive(account, value, now)) ?? candidates[0]
            const managed = grants.find(value => value.meter === 'managed_ai' && value.sourceKey === current?.sourceKey)
            const billingMode = hostingConfiguration.getBillingMode()
            let policy: ReturnType<typeof readStripePolicy> | null = null
            try {
                if (billingMode === 'stripe_test') policy = readStripePolicy()
            }
            catch { /* Existing entitlement remains readable without purchasing configuration. */ }
            const configured = account.catalogVersion === hostingCatalog.version && policy !== null && (!bound || (bound.catalogHash === policy.hash && bound.stripeAccountId === policy.catalog.accountId))
            const identityMatches = (command: StripeCommand) => command.actorIdentityId === actor.identityId && command.tokenVersion === (actor.tokenVersion ?? null)
            const commandReason = (command: StripeCommand | undefined): HostedBillingActionReason | null => {
                if (!command) return null
                if (!identityMatches(command)) return 'session_changed'
                if (command.firstSentAt && now.getTime() - command.firstSentAt.getTime() > 23 * 3600_000 && command.state !== 'ready') return 'recovery_required'
                if (command.state === 'running' && command.leaseUntil && command.leaseUntil > now) return 'checkout_pending'
                if (command.state === 'ready' && command.kind === 'customer' && !bound?.customerId) return 'recovery_required'
                if (command.payloadHash !== stripeDigest(command.payload) || command.payload.catalogHash !== policy?.hash) return 'billing_unavailable'
                return null
            }
            const checkout = open.find(value => value.kind === 'checkout')
            const expiredCheckout = checkout?.state === 'ready' && !!checkout.objectId && !!checkout.expiresAt && checkout.expiresAt <= now
            const customer = open.find(value => value.kind === 'customer')
            const portal = open.find(value => value.kind === 'portal' && !(value.state === 'ready' && value.expiresAt && value.expiresAt <= now))
            const ended = account.status !== 'suspended' && subscriptionAccountUntil(account) <= now && bound?.holds.length === 1 && bound.holds[0] === 'subscription_ended'
            const paused = account.status === 'suspended' || (account.billingHold === true && !ended)
            const plans = (['starter', 'team'] as const).map(id => {
                const limits = hostingCatalog.getPlan({ planId: id })
                let reason: HostedBillingActionReason | null = billingMode === 'manual' ? 'manual_billing' : !configured ? 'billing_unavailable' : account.status === 'suspended' ? 'account_paused' : null
                if (!reason && bound?.holds.some(value => value !== 'subscription_ended')) reason = 'billing_review'
                if (!reason && account.billingHold && !(bound?.holds.length === 1 && bound.holds[0] === 'subscription_ended')) reason = 'billing_review'
                if (!reason && (usage.users + usage.pendingUsers > limits.users || usage.projects + usage.pendingProjects > limits.projects)) reason = 'resource_limit'
                if (!reason && bound?.subscriptionId && (!['canceled', 'incomplete_expired'].includes(bound.subscriptionStatus ?? '') || account.validUntil > now)) reason = 'subscription_exists'
                if (!reason && !bound?.customerId) reason = commandReason(customer)
                if (!reason && !expiredCheckout) reason = commandReason(checkout)
                if (!reason && !expiredCheckout && checkout && checkout.payload.planId !== id) reason = 'checkout_pending'
                const price = configured && policy ? { amountMinor: policy.catalog.plans[id].amountMinor, currency: policy.catalog.plans[id].currency, interval: 'month' as const } : null
                return { id, limits: { ...limits, byokEnabled: true as const }, price, checkout: { enabled: reason === null, reason, continuing: !!checkout && (expiredCheckout || checkout.payload.planId === id) } }
            })
            const portalReason = billingMode === 'manual' ? 'manual_billing' as const : !configured ? 'billing_unavailable' : !bound?.customerId ? 'customer_missing' : commandReason(portal)
            const effectiveAiCredits = await effectiveManagedAiCredits(manager, account.id, account.planId)
            const previousHeld = grants.filter(value => value.meter === 'managed_ai' && value.id !== managed?.id).reduce((sum, value) => sum + value.reserved, 0n)
            return HostedBillingOverview.parse({
                schemaVersion: 1, platformId: account.id, userId: user.id, catalogVersion: account.catalogVersion, serverTime: now.toISOString(), billingMode, environment: billingMode === 'manual' ? 'manual' : 'test',
                planId: account.planId, status: account.status, entitlementState: paused ? 'paused' : subscriptionAccountUntil(account) <= now ? 'expired' : account.planId === 'trial' ? 'trial' : account.planId === 'training' ? 'training' : account.planId === 'assessment' ? 'assessment' : 'paid', validUntil: subscriptionAccountUntil(account).toISOString(), trialEndsAt: account.trialEndsAt.toISOString(), billingHold: account.billingHold ?? false, subscriptionStatus: bound?.subscriptionStatus ?? null, planChangesEnabled: false,
                notice: account.status === 'suspended' ? 'account_paused' : account.billingHold && !ended ? 'billing_review' : bound?.lastError ? 'billing_delayed' : null,
                meters: { execution: meter(current, now, !paused && subscriptionAccountActive(account, now), account), managedAi: meter(managed, now, !paused && subscriptionAccountActive(account, now), account), previousPeriodHeldMicroUsd: previousHeld.toString() }, usage: { ...usage, activeExecutions: account.activeExecutions }, limits: { ...hostingCatalog.getPlan({ planId: account.planId }), aiCredits: effectiveAiCredits, byokEnabled: true }, plans, portal: { enabled: portalReason === null, reason: portalReason, continuing: false },
            })
        } })
    } }
}
function meter(grant: HostingGrant | undefined, now: Date, spendable: boolean, account: import('./hosting-entities').HostingAccount) {
    if (!grant) return { state: 'missing', amount: '0', consumed: '0', reserved: '0', available: '0', validFrom: null, validUntil: null }
    const active = subscriptionGrantActive(account, grant, now)
    const remaining = grant.amount - grant.consumed - grant.reserved
    return { state: grant.revokedAt ? 'revoked' : active ? 'active' : 'expired', amount: grant.amount.toString(), consumed: grant.consumed.toString(), reserved: grant.reserved.toString(), available: spendable && active && remaining > 0n ? remaining.toString() : '0', validFrom: grant.validFrom.toISOString(), validUntil: subscriptionGrantUntil(account, grant).toISOString() }
}
