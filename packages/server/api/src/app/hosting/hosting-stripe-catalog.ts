import { apId } from '@activepieces/core-utils'
import { DataSource, EntityManager } from 'typeorm'
import { z } from 'zod'
import { assertHostingOperator } from './hosting-access-policy'
import { hostingConfiguration } from './hosting-configuration'
import { createStripeAdapter } from './hosting-stripe-adapter'
import { HostingStripeBindingEntity, HostingStripeCatalogChangeEntity, HostingStripeCatalogPreviewEntity, HostingStripeCommandEntity, HostingStripeInboxEntity, HostingStripePeriodEntity, StripeCatalogPreview, StripeCommand } from './hosting-stripe-entities'
import { readStripePolicy, stripeDigest } from './hosting-stripe-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const StripeCatalogConfirmInput = z.strictObject({ platformId: z.string().length(21), previewId: z.string().length(21), requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), reason: z.string().trim().min(3).max(500) })
type ConfirmInput = z.input<typeof StripeCatalogConfirmInput>
export function createHostedStripeCatalog({ dataSource }: { dataSource: DataSource }) {
    async function local(manager: EntityManager, platformId: string) {
        const bound = await manager.getRepository(HostingStripeBindingEntity).findOneBy({ platformId })
        if (!bound) return null
        const commands = await manager.getRepository(HostingStripeCommandEntity).find({ where: { platformId }, order: { id: 'ASC' }, take: 257 })
        const periods = await manager.getRepository(HostingStripePeriodEntity).find({ where: { platformId }, order: { id: 'ASC' }, take: 129 })
        const inbox = bound.customerId ? await manager.getRepository(HostingStripeInboxEntity).find({ where: { stripeAccountId: bound.stripeAccountId, customerId: bound.customerId, state: 'pending' }, order: { id: 'ASC' }, take: 101 }) : []
        return { bound, commands, periods, inbox }
    }
    type Local = NonNullable<Awaited<ReturnType<typeof local>>>
    function assertQuiet(value: Local, now: Date) {
        if (value.commands.length > 256 || value.periods.length > 128 || value.inbox.length > 100) hostingFail('HOSTING_STRIPE_CATALOG_HISTORY_LIMIT')
        if ((value.bound.leaseUntil && value.bound.leaseUntil > now) || (value.bound.fence && !value.bound.leaseUntil)) hostingFail('HOSTING_STRIPE_CATALOG_RECONCILIATION_BUSY')
        // Pending events and command history are frozen into the preview.
        // A stale catalog must not deadlock the normal reconciliation needed
        // to process them. Only independently proven commands can be retired.
    }
    async function withTarget<T>(actor: HostingActor, platformId: string, fn: (manager: EntityManager, userId: string) => Promise<T>) {
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            await tx.account({ manager, platformId })
            const user = await assertHostingOperator({ manager, actor })
            return fn(manager, user.id)
        } })
    }
    async function read({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return withTarget(actor, platformId, async (manager, userId) => {
            const base = { platformId: actor.platformId, userId, scopePlatformId: platformId }
            if (hostingConfiguration.getBillingMode() !== 'stripe_test') return { ...base, mode: 'manual' as const, state: 'manual' as const, currentHash: null, targetHash: null, revision: null }
            const policy = readStripePolicy(), value = await local(manager, platformId)
            return { ...base, mode: 'stripe_test' as const, state: !value ? 'unbound' as const : value.bound.catalogHash === policy.hash ? 'current' as const : 'migration_required' as const, currentHash: value?.bound.catalogHash ?? null, targetHash: policy.hash, revision: value?.bound.revision ?? null }
        })
    }
    async function preview({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        if (hostingConfiguration.getBillingMode() !== 'stripe_test') hostingFail('HOSTING_STRIPE_TEST_CONFIGURATION_REQUIRED')
        const policy = readStripePolicy()
        const initial = await withTarget(actor, platformId, async manager => {
            const value = await local(manager, platformId)
            if (!value) hostingFail('HOSTING_STRIPE_CATALOG_BINDING_REQUIRED')
            assertQuiet(value, await tx.now(manager))
            if (value.bound.stripeAccountId !== policy.catalog.accountId) hostingFail('HOSTING_STRIPE_ACCOUNT_MISMATCH')
            if (value.bound.catalogHash === policy.hash) hostingFail('HOSTING_STRIPE_CATALOG_ALREADY_CURRENT')
            return value
        })
        const adapter = await createStripeAdapter(policy)
        const evidence = await adapter.catalogEvidence({ customerId: initial.bound.customerId, subscriptionId: initial.bound.subscriptionId, chargeIds: [...new Set(initial.periods.flatMap(row => row.chargeIds))] })
        const commands = await adapter.catalogCommandEvidence(initial.commands, initial.bound.customerId, evidence.subscriptionId)
        assertEvidence(evidence, platformId, initial.bound.subscriptionId, initial.bound.customerId, initial.commands, commands)
        return withTarget(actor, platformId, async (manager, userId) => {
            const current = await local(manager, platformId)
            if (!current || stripeDigest(current) !== stripeDigest(initial) || readStripePolicy().hash !== policy.hash) hostingFail('HOSTING_STRIPE_CATALOG_PREVIEW_STALE')
            assertQuiet(current, await tx.now(manager))
            const now = await tx.now(manager), expiresAt = new Date(now.getTime() + 5 * 60_000)
            const row = await manager.getRepository(HostingStripeCatalogPreviewEntity).save({ id: apId(), platformId, operatorIdentityId: actor.identityId, tokenVersion: actor.tokenVersion ?? null, sourceHash: current.bound.catalogHash, targetHash: policy.hash, evidenceHash: stripeDigest({ evidence, commands }), expiresAt, snapshot: JSON.parse(JSON.stringify({ local: current, evidence, commands, catalog: policy.catalog })) as Record<string, unknown> })
            return { platformId: actor.platformId, userId, scopePlatformId: platformId, previewId: row.id, expiresAt: expiresAt.toISOString(), currentHash: row.sourceHash, targetHash: row.targetHash, revision: current.bound.revision, accountId: policy.catalog.accountId, customerId: current.bound.customerId, subscriptionId: evidence.subscriptionId, subscriptionStatus: evidence.subscriptionStatus, plans: policy.catalog.plans, retiringCommands: commands, pendingEvents: current.inbox.length, retiringExpiredLease: !!(current.bound.fence || current.bound.leaseUntil) }
        })
    }
    async function confirm({ actor, input }: { actor: HostingActor, input: ConfirmInput }) {
        const value = StripeCatalogConfirmInput.parse(input), payloadHash = stripeDigest(value)
        const claim = await withTarget(actor, value.platformId, async manager => {
            const receipt = await manager.getRepository(HostingStripeCatalogChangeEntity).findOneBy({ operatorIdentityId: actor.identityId, requestKey: value.requestKey })
            if (receipt) {
                if (receipt.payloadHash !== payloadHash || receipt.platformId !== value.platformId) hostingFail('HOSTING_STRIPE_CATALOG_IDEMPOTENCY_CONFLICT')
                return { receipt }
            }
            const row = await manager.getRepository(HostingStripeCatalogPreviewEntity).findOneBy({ id: value.previewId, platformId: value.platformId })
            await validatePreview(manager, actor, row)
            const current = await local(manager, value.platformId)
            if (!current || stripeDigest(current) !== stripeDigest(row!.snapshot.local)) hostingFail('HOSTING_STRIPE_CATALOG_PREVIEW_STALE')
            assertQuiet(current, await tx.now(manager))
            return { row: row!, current }
        })
        if (claim.receipt) return { changeId: claim.receipt.id, revision: claim.receipt.revision, replayed: true }
        const policy = readStripePolicy(), adapter = await createStripeAdapter(policy)
        const evidence = await adapter.catalogEvidence({ customerId: claim.current!.bound.customerId, subscriptionId: claim.current!.bound.subscriptionId, chargeIds: [...new Set(claim.current!.periods.flatMap(row => row.chargeIds))] })
        const commands = await adapter.catalogCommandEvidence(claim.current!.commands, claim.current!.bound.customerId, evidence.subscriptionId)
        assertEvidence(evidence, value.platformId, claim.current!.bound.subscriptionId, claim.current!.bound.customerId, claim.current!.commands, commands)
        if (stripeDigest({ evidence, commands }) !== claim.row!.evidenceHash) hostingFail('HOSTING_STRIPE_CATALOG_PROVIDER_CHANGED')
        return withTarget(actor, value.platformId, async manager => {
            const repo = manager.getRepository(HostingStripeCatalogChangeEntity), previous = await repo.findOneBy({ previewId: value.previewId })
            if (previous) {
                if (previous.payloadHash !== payloadHash || previous.operatorIdentityId !== actor.identityId || previous.requestKey !== value.requestKey) hostingFail('HOSTING_STRIPE_CATALOG_IDEMPOTENCY_CONFLICT')
                return { changeId: previous.id, revision: previous.revision, replayed: true }
            }
            await validatePreview(manager, actor, claim.row!)
            const current = await local(manager, value.platformId)
            if (!current || stripeDigest(current) !== stripeDigest(claim.row!.snapshot.local)) hostingFail('HOSTING_STRIPE_CATALOG_PREVIEW_STALE')
            assertQuiet(current, await tx.now(manager))
            for (const command of commands) await manager.getRepository(HostingStripeCommandEntity).update({ id: command.commandId, platformId: value.platformId }, { state: 'closed' })
            const revision = current.bound.revision + 1, id = apId()
            await repo.insert({ id, platformId: value.platformId, previewId: value.previewId, operatorIdentityId: actor.identityId, requestKey: value.requestKey, payloadHash, sourceHash: claim.row!.sourceHash, targetHash: policy.hash, evidenceHash: claim.row!.evidenceHash, revision, reason: value.reason })
            // Catalog authority only. Existing holds, paid periods, grants and
            // subscription prices are deliberately preserved byte-for-byte.
            await manager.getRepository(HostingStripeBindingEntity).update({ id: current.bound.id, revision: current.bound.revision, catalogHash: current.bound.catalogHash }, { catalogHash: policy.hash, revision, reconcileAt: await tx.now(manager), fence: null, leaseUntil: null })
            const saved = await manager.getRepository(HostingStripeBindingEntity).findOneByOrFail({ id: current.bound.id })
            if (saved.catalogHash !== policy.hash || saved.revision !== revision) hostingFail('HOSTING_STRIPE_CATALOG_PREVIEW_STALE')
            await tx.event({ manager, platformId: value.platformId, event: 'stripe.catalog_migrated', payload: { changeId: id, previewId: value.previewId, operatorIdentityId: actor.identityId, sourceHash: claim.row!.sourceHash, targetHash: policy.hash, evidenceHash: claim.row!.evidenceHash, revision, retiringCommands: commands, pendingEventsPreserved: current.inbox.length, retiredExpiredLease: !!(current.bound.fence || current.bound.leaseUntil) } })
            return { changeId: id, revision, replayed: false }
        })
    }
    async function validatePreview(manager: EntityManager, actor: HostingActor, row: StripeCatalogPreview | null | undefined) {
        if (!row || row.operatorIdentityId !== actor.identityId || row.tokenVersion !== (actor.tokenVersion ?? null)) hostingFail('HOSTING_STRIPE_CATALOG_PREVIEW_DENIED')
        if (row.expiresAt <= await tx.now(manager)) hostingFail('HOSTING_STRIPE_CATALOG_PREVIEW_EXPIRED')
        if (hostingConfiguration.getBillingMode() !== 'stripe_test' || readStripePolicy().hash !== row.targetHash) hostingFail('HOSTING_STRIPE_CATALOG_PREVIEW_STALE')
    }
    async function safeConfirm(args: { actor: HostingActor, input: ConfirmInput }) {
        try {
            return await confirm(args)
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') hostingFail('HOSTING_STRIPE_CATALOG_IDEMPOTENCY_CONFLICT')
            throw error
        }
    }
    return { read, preview, confirm: safeConfirm }
}
function assertEvidence(evidence: Awaited<ReturnType<Awaited<ReturnType<typeof createStripeAdapter>>['catalogEvidence']>>, platformId: string, subscriptionId: string | null, customerId: string | null, sourceCommands: StripeCommand[], commands: { commandId: string, reason: string }[]) {
    if (evidence.issues.length) hostingFail(evidence.issues[0])
    if (evidence.customerPlatformId !== null && evidence.customerPlatformId !== platformId) hostingFail('HOSTING_STRIPE_CUSTOMER_CONFLICT')
    if (evidence.subscriptionId && evidence.subscriptionPlatformId !== platformId) hostingFail('HOSTING_STRIPE_SUBSCRIPTION_CONFLICT')
    if (evidence.subscriptionId === subscriptionId) return
    const purchase = sourceCommands.find(row => row.id === evidence.commandId && row.kind === 'checkout')
    const provenComplete = purchase && commands.some(row => row.commandId === purchase.id && row.reason === 'checkout_completed')
    if (subscriptionId || !evidence.subscriptionId || !evidence.period || !purchase || purchase.payloadHash !== stripeDigest(purchase.payload) || purchase.payload.customerId !== customerId || purchase.payload.planId !== evidence.period.planId || !provenComplete) hostingFail('HOSTING_STRIPE_SUBSCRIPTION_CONFLICT')
}
