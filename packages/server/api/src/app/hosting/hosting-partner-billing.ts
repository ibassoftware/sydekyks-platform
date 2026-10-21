import { apId } from '@activepieces/core-utils'
import { DataSource, EntityManager, In, IsNull, LessThanOrEqual } from 'typeorm'
import { LmsCourseEntity, LmsEnrollmentEntity } from '../lms/lms-entities'
import { isOperationalUser } from './hosting-access-policy'
import { hostingResourceUsage } from './hosting-billing-resources'
import { hostingConfiguration } from './hosting-configuration'
import { HostingAccount, HostingReservationEntity } from './hosting-entities'
import { HostingManualAccountEntity } from './hosting-manual-accounts-entities'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { createPartnerStripeAdapter, PartnerPaymentEvidence, PartnerStripePolicy, readPartnerStripePolicy } from './hosting-partner-billing-adapter'
import { HostingPartnerPurchaseAuditEntity, HostingPartnerPurchaseEntity, PartnerPackage, PartnerPurchase } from './hosting-partner-billing-entities'
import { fulfillPartnerPurchaseReceipt, revokePartnerPurchaseReceipt } from './hosting-partner-billing-receipt'
import { HostingStripeBindingEntity } from './hosting-stripe-entities'
import { readStripePolicy } from './hosting-stripe-policy'
import { HostingTrainingEntity } from './hosting-training-entity'
import { HostingActor, HostingError, hostingFail, hostingTransactions as tx } from './hosting-transactions'

type Adapter = Awaited<ReturnType<typeof createPartnerStripeAdapter>>
const ACTIVE = ['prepared', 'ready', 'fulfilled', 'refunded', 'review'] as const
const RETRY_MS = 60_000
// Partial refunds preserve the purchased entitlement. A full verified refund is
// irrevocable for this receipt, and never retargets another purchase's funding.
export function partnerRefundPolicy(amountMinor: number, refundedMinor: number): 'preserve' | 'revoke' {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0 || !Number.isInteger(refundedMinor) || refundedMinor < 0 || refundedMinor > amountMinor) hostingFail('HOSTING_PARTNER_REFUND_UNVERIFIED')
    return refundedMinor === amountMinor ? 'revoke' : 'preserve'
}
export async function createHostedPartnerBilling({ dataSource, policy: suppliedPolicy, adapter: suppliedAdapter }: { dataSource: DataSource, policy?: PartnerStripePolicy, adapter?: Adapter }) {
    if (hostingConfiguration.getServiceMode() !== 'hosted') hostingFail('HOSTED_INSTALLATION_REQUIRED')
    const mode = hostingConfiguration.getBillingMode()
    let policy: PartnerStripePolicy | null = null, adapter: Adapter | null = null, merchantAccountId: string | null = null
    if (mode === 'stripe_test') {
        try {
            policy = suppliedPolicy ?? readPartnerStripePolicy(); merchantAccountId = policy.catalog.accountId; adapter = suppliedAdapter ?? await createPartnerStripeAdapter(policy) 
        }
        catch (error) {
            if (!(error instanceof HostingError)) throw error
            // Missing/changed sale configuration never disables old refund checks.
            try {
                const historical = readStripePolicy(); merchantAccountId = historical.catalog.accountId; adapter = suppliedAdapter ?? await createPartnerStripeAdapter(historical) 
            }
            catch (historicalError) {
                if (!(historicalError instanceof HostingError)) throw historicalError 
            }
        }
    }
    function configured(): { policy: PartnerStripePolicy, adapter: Adapter } {
        if (mode !== 'stripe_test') hostingFail('HOSTING_MANUAL_BILLING_REQUIRED')
        if (!policy || !adapter) hostingFail('HOSTING_PARTNER_CHECKOUT_UNCONFIGURED')
        return { policy, adapter }
    }
    async function owner(manager: EntityManager, actor: HostingActor) {
        const account = await tx.account({ manager, platformId: actor.platformId })
        const member = await tx.member({ manager, actor, admin: true })
        if (account.ownerIdentityId !== actor.identityId || isOperationalUser(member)) hostingFail('HOSTING_ACCESS_DENIED')
        return { account, member }
    }
    async function eligible(manager: EntityManager, account: HostingAccount, identityId: string, courseId: string): Promise<void> {
        if (await manager.getRepository(HostingManualAccountEntity).existsBy({ id: account.id })) hostingFail('HOSTING_MANUAL_FUNDING_REQUIRES_REVIEW')
        const course = await manager.getRepository(LmsCourseEntity).findOneBy({ id: courseId, status: 'published', ownerPlatformId: IsNull(), audience: 'partner', certificationMode: 'partner' })
        if (!course) hostingFail('HOSTING_PARTNER_COURSE_UNAVAILABLE')
        if (account.ownerIdentityId !== identityId || account.planId !== 'trial' || account.status === 'suspended' || account.billingHold || account.activeExecutions !== 0 ||
            await manager.getRepository(HostingStripeBindingEntity).existsBy({ platformId: account.id }) ||
            await manager.getRepository(HostingTrainingEntity).existsBy({ platformId: account.id }) ||
            await manager.getRepository(LmsEnrollmentEntity).existsBy({ identityId, courseId, grantPlatformId: IsNull() }) ||
            await manager.getRepository(HostingReservationEntity).existsBy({ platformId: account.id, state: In(['reserved', 'running', 'uncertain', 'paused']) }) ||
            await manager.getRepository(HostingModelCallEntity).existsBy({ platformId: account.id, state: In(['prepared', 'running', 'uncertain']) })) hostingFail('HOSTING_PARTNER_PURCHASE_REQUIRES_REVIEW')
        const usage = await hostingResourceUsage(manager, account.id, await tx.now(manager))
        if (usage.users + usage.pendingUsers > 1 || usage.projects + usage.pendingProjects > 1) hostingFail('HOSTING_PARTNER_OWN_WORKSPACE_REQUIRED')
    }
    async function audit(manager: EntityManager, row: PartnerPurchase, event: string, evidence: Record<string, unknown>, patch: Partial<PartnerPurchase> = {}) {
        const revision = row.revision + 1
        const saved = await manager.getRepository(HostingPartnerPurchaseEntity).save({ ...row, ...patch, revision })
        await manager.getRepository(HostingPartnerPurchaseAuditEntity).save({ id: apId(), purchaseId: row.id, revision, event, evidence })
        await tx.event({ manager, platformId: row.platformId, event: `partner.purchase.${event}`, payload: { purchaseId: row.id, revision, ...evidence } })
        return saved
    }
    async function status(actor: HostingActor) {
        return tx.run({ dataSource, fn: async manager => {
            const { account, member } = await owner(manager, actor)
            const row = await manager.getRepository(HostingPartnerPurchaseEntity).findOne({ where: { platformId: account.id, state: In([...ACTIVE]) }, order: { created: 'DESC' } })
            let reason: string | null = mode === 'manual' ? 'manual' : !policy ? 'unconfigured' : null
            if (!row && !reason && policy) {
                try {
                    await eligible(manager, account, actor.identityId, policy.partnerCourseId) 
                }
                catch (error) {
                    if (!(error instanceof HostingError)) throw error; reason = 'review' 
                }
            }
            const training = row?.trainingId ? await manager.getRepository(HostingTrainingEntity).findOneBy({ id: row.trainingId, receiptId: `stripe-partner:${row.id}` }) : null
            return { platformId: account.id, userId: member.id, billingMode: mode, available: !reason && !row, reason, purchase: row ? { package: row.package, state: row.reason && row.reason !== 'HOSTING_PARTNER_RECONCILIATION_PENDING' ? 'review' : row.state, accessUntil: training?.endsAt.toISOString() ?? null, refundedMinor: row.refundedMinor } : null }
        } })
    }
    async function checkout(actor: HostingActor, selected: PartnerPackage) {
        const { policy } = configured()
        if (!['core', 'guided'].includes(selected)) hostingFail('HOSTING_PARTNER_PACKAGE_DENIED')
        const row = await tx.run({ dataSource, fn: async manager => {
            const { account } = await owner(manager, actor)
            const existing = await manager.getRepository(HostingPartnerPurchaseEntity).findOneBy({ platformId: account.id, state: In([...ACTIVE]) })
            if (existing) {
                if (existing.package !== selected || existing.identityId !== actor.identityId || existing.tokenVersion !== (actor.tokenVersion ?? null)) hostingFail('HOSTING_PARTNER_COMMAND_CONFLICT')
                return existing
            }
            await eligible(manager, account, actor.identityId, policy.partnerCourseId)
            const now = await tx.now(manager), price = policy.partnerPackages[selected]
            const created = await manager.getRepository(HostingPartnerPurchaseEntity).save({ id: apId(), platformId: account.id, identityId: actor.identityId, tokenVersion: actor.tokenVersion ?? null, courseId: policy.partnerCourseId, package: selected, stripeAccountId: policy.catalog.accountId, policyHash: policy.hash, priceId: price.priceId, amountMinor: price.amountMinor, state: 'prepared', reconcileAt: now, refundedMinor: 0, revision: 0 })
            return audit(manager, created, 'prepared', { package: selected, amountMinor: price.amountMinor, policyHash: policy.hash })
        } })
        await process(row.id)
        return tx.run({ dataSource, fn: async manager => {
            await owner(manager, actor)
            const current = await manager.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id: row.id })
            const now = await tx.now(manager)
            if (current.identityId !== actor.identityId || current.tokenVersion !== (actor.tokenVersion ?? null)) hostingFail('HOSTING_ACCESS_DENIED')
            if (current.state === 'review' || (current.reason && current.reason !== 'HOSTING_PARTNER_RECONCILIATION_PENDING')) hostingFail('HOSTING_PARTNER_PURCHASE_REQUIRES_REVIEW')
            return { commandId: current.id, state: current.state, url: current.state === 'ready' && current.expiresAt && current.expiresAt > now ? current.checkoutUrl : null }
        } })
    }
    async function claim(id: string): Promise<PartnerPurchase | null> {
        return tx.run({ dataSource, fn: async manager => {
            const peek = await manager.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id })
            // Account lock serializes with checkout and credit/receipt mutation.
            await tx.account({ manager, platformId: peek.platformId })
            const row = await manager.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id })
            const now = await tx.now(manager)
            if (['expired', 'refunded', 'review'].includes(row.state) || (row.leaseUntil && row.leaseUntil > now)) return null
            if (row.stripeAccountId !== merchantAccountId || (row.state === 'prepared' && (!policy || row.policyHash !== policy.hash || (row.firstSentAt && now.getTime() - row.firstSentAt.getTime() > 23 * 3600_000)))) {
                await audit(manager, row, 'review_required', { reason: 'policy_or_command_window' }, { state: 'review', reason: 'policy_or_command_window', checkoutUrl: null }); return null
            }
            if (row.state === 'prepared') {
                const actor = { platformId: row.platformId, identityId: row.identityId, tokenVersion: row.tokenVersion }
                const { account } = await owner(manager, actor)
                await eligible(manager, account, row.identityId, row.courseId)
            }
            return manager.getRepository(HostingPartnerPurchaseEntity).save({ ...row, fence: apId(), leaseUntil: new Date(now.getTime() + 120_000), firstSentAt: row.firstSentAt ?? now, reconcileAt: new Date(now.getTime() + RETRY_MS) })
        } })
    }
    async function process(id: string) {
        if (!adapter) hostingFail('HOSTING_PARTNER_CHECKOUT_UNCONFIGURED')
        const claimed = await claim(id)
        if (!claimed) return
        let row = claimed
        try {
            if (row.state === 'prepared') {
                if (!row.customerId) {
                    const customerId = await adapter.customer(row)
                    row = await fenced(row, async (manager, current) => audit(manager, current, 'customer_created', { customerId }, { customerId }))
                }
                const session = await adapter.create(row)
                row = await fenced(row, async (manager, current) => audit(manager, current, 'checkout_created', { sessionId: session.sessionId }, { ...session, state: 'ready' }))
            }
            const evidence = await adapter.snapshot(row)
            await apply(row, evidence)
        }
        catch (error) {
            await tx.run({ dataSource, fn: async manager => {
                await tx.account({ manager, platformId: row.platformId })
                const current = await manager.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id: row.id })
                if (current.fence !== row.fence) return
                const reason = error instanceof HostingError ? error.message : 'HOSTING_PARTNER_RECONCILIATION_PENDING'
                await audit(manager, current, 'reconcile_failed', { reason }, { leaseUntil: null, reconcileAt: new Date((await tx.now(manager)).getTime() + RETRY_MS), reason })
            } })
        }
    }
    async function fenced<T>(row: PartnerPurchase, fn: (manager: EntityManager, current: PartnerPurchase) => Promise<T>): Promise<T> {
        return tx.run({ dataSource, fn: async manager => {
            if (row.enrollmentId) await manager.getRepository(LmsEnrollmentEntity).findOne({ where: { id: row.enrollmentId }, lock: { mode: 'pessimistic_write' } })
            await tx.account({ manager, platformId: row.platformId })
            const current = await manager.getRepository(HostingPartnerPurchaseEntity).findOneByOrFail({ id: row.id })
            if (current.fence !== row.fence) hostingFail('HOSTING_PARTNER_COMMAND_FENCE_MISMATCH')
            return fn(manager, current)
        } })
    }
    async function apply(row: PartnerPurchase, evidence: PartnerPaymentEvidence) {
        await fenced(row, async (manager, current) => {
            const now = await tx.now(manager), next = new Date(now.getTime() + RETRY_MS)
            if (evidence.status !== 'paid') {
                if (current.state === 'fulfilled') hostingFail('HOSTING_PARTNER_PAYMENT_EVIDENCE_CHANGED')
                await audit(manager, current, evidence.status === 'expired' ? 'checkout_expired' : 'checkout_pending', { status: evidence.status }, { state: evidence.status === 'expired' ? 'expired' : 'ready', leaseUntil: null, reconcileAt: next, reason: null }); return
            }
            if (current.chargeId && (current.chargeId !== evidence.chargeId || current.paymentIntentId !== evidence.paymentIntentId)) hostingFail('HOSTING_PARTNER_PAYMENT_EVIDENCE_CHANGED')
            if (current.refundedMinor > evidence.refundedMinor) hostingFail('HOSTING_PARTNER_REFUND_EVIDENCE_CHANGED')
            // Persist verified provider evidence before calling receipt service, in
            // the same atomic transaction as LMS enrollment and grant issuance.
            let verified: PartnerPurchase = await manager.getRepository(HostingPartnerPurchaseEntity).save({ ...current, chargeId: evidence.chargeId, paymentIntentId: evidence.paymentIntentId, refundedMinor: evidence.refundedMinor })
            const fullRefund = partnerRefundPolicy(verified.amountMinor, verified.refundedMinor) === 'revoke'
            if (fullRefund) {
                if (verified.enrollmentId) await revokePartnerPurchaseReceipt({ dataSource, manager, purchase: verified })
                verified = await audit(manager, verified, 'fully_refunded', { evidenceHash: evidence.evidenceHash, chargeId: evidence.chargeId, refundedMinor: evidence.refundedMinor }, { state: 'refunded', leaseUntil: null, checkoutUrl: null, reason: null, reconcileAt: next })
            }
            else {
                const receipt = await fulfillPartnerPurchaseReceipt({ dataSource, manager, purchase: verified })
                const changed = !current.enrollmentId || current.refundedMinor !== evidence.refundedMinor
                const patch = { state: 'fulfilled' as const, enrollmentId: receipt.enrollmentId, trainingId: receipt.trainingId, leaseUntil: null, checkoutUrl: null, reason: null, reconcileAt: next }
                if (changed) await audit(manager, verified, current.enrollmentId ? 'partial_refund_preserved' : 'fulfilled', { evidenceHash: evidence.evidenceHash, chargeId: evidence.chargeId, refundedMinor: evidence.refundedMinor, enrollmentId: receipt.enrollmentId, trainingId: receipt.trainingId }, patch)
                else await manager.getRepository(HostingPartnerPurchaseEntity).save({ ...verified, ...patch })
            }
        })
    }
    // Provider reads are bounded and can be called by the existing normal billing
    // loop. Unknown network writes replay their original idempotency keys only.
    async function recover(limit = 25) {
        if (!adapter || mode !== 'stripe_test') return
        const rows = await dataSource.getRepository(HostingPartnerPurchaseEntity).find({ where: { state: In(['prepared', 'ready', 'fulfilled']), reconcileAt: LessThanOrEqual(new Date()) }, order: { reconcileAt: 'ASC', id: 'ASC' }, take: Math.min(50, Math.max(1, limit)) })
        for (const row of rows) {
            try {
                await process(row.id) 
            }
            catch { /* Persisted command remains available to the next bounded recovery pass. */ }
        }
    }
    return { status, checkout, recover }
}
