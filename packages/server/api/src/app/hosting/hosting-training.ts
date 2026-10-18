import { apId } from '@activepieces/core-utils'
import { HOSTED_MICRO_USD_PER_CREDIT, hostingCatalog } from '@activepieces/shared'
import { DataSource, EntityManager, In } from 'typeorm'
import { z } from 'zod'
import { assertHostingOperator } from './hosting-access-policy'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity, HostingReservationEntity } from './hosting-entities'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { HostingStripeBindingEntity } from './hosting-stripe-entities'
import { HostingTraining, HostingTrainingEntity } from './hosting-training-entity'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const bindingSchema = z.strictObject({
    platformId: z.string().length(21), identityId: z.string().length(21), enrollmentId: z.string().length(21),
    receiptId: z.string().trim().min(1).max(180), tier: z.enum(['core', 'launch']),
})
type Binding = z.infer<typeof bindingSchema>

// Internal operator fulfillment API. The caller must load a verified persisted LMS
// enrollment/payment record; course completion or browser payment assertions are not authority.
export function createHostedTraining({ dataSource, manager: existingManager }: { dataSource: DataSource, manager?: EntityManager }) {
    async function activate({ actor, ...binding }: Binding & { actor: HostingActor }): Promise<HostingTraining> {
        const input = bindingSchema.parse(binding)
        return tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const account = await tx.account({ manager, platformId: input.platformId })
            if (account.ownerIdentityId !== input.identityId) hostingFail('HOSTING_TRAINING_RECIPIENT_MISMATCH')
            const rows = await manager.getRepository(HostingTrainingEntity).find({ where: [
                { platformId: input.platformId }, { enrollmentId: input.enrollmentId }, { receiptId: input.receiptId },
            ] })
            if (rows.length) {
                const existing = rows[0]
                if (rows.length !== 1 || Object.entries(input).some(([key, value]) => existing[key as keyof Binding] !== value)) hostingFail('HOSTING_IDEMPOTENCY_CONFLICT')
                return existing
            }
            // Do not erase liabilities or silently replace a subscription with a course grant.
            if (account.planId !== 'trial' || account.status === 'suspended' || account.billingHold || account.activeExecutions !== 0 ||
                await manager.getRepository(HostingStripeBindingEntity).existsBy({ platformId: account.id }) ||
                await manager.getRepository(HostingReservationEntity).existsBy({ platformId: account.id, state: In(['reserved', 'running', 'uncertain', 'paused']) }) ||
                await manager.getRepository(HostingModelCallEntity).existsBy({ platformId: account.id, state: In(['prepared', 'running', 'uncertain']) })) hostingFail('HOSTING_TRAINING_ACTIVATION_REQUIRES_REVIEW')
            const startsAt = await tx.now(manager)
            const periods = hostingCatalog.trainingPeriods[input.tier]
            const periodMs = hostingCatalog.trainingPeriodDays * 86_400_000
            const endsAt = new Date(startsAt.getTime() + periods * periodMs)
            const record = await manager.getRepository(HostingTrainingEntity).save({ id: apId(), ...input, operatorIdentityId: actor.identityId, startsAt, endsAt, revokedAt: null })
            const limits = hostingCatalog.getPlan({ planId: 'training' })
            // All periods are created exactly once. Future allowances cannot be used early;
            // balance reads never grant credits and no renewal scheduler can duplicate them.
            for (let period = 0; period < periods; period++) {
                for (const [meter, amount] of [['execution', BigInt(limits.executions)], ['managed_ai', BigInt(limits.aiCredits) * HOSTED_MICRO_USD_PER_CREDIT]] as const) {
                    const grantId = apId()
                    await manager.getRepository(HostingGrantEntity).insert({
                        id: grantId, platformId: account.id, sourceKey: `training:${record.id}:${period}`, meter, amount, reserved: 0n, consumed: 0n,
                        validFrom: new Date(startsAt.getTime() + period * periodMs), validUntil: new Date(startsAt.getTime() + (period + 1) * periodMs),
                    })
                    await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId, reservationId: null, operation: 'grant', key: `grant:${grantId}`, amount })
                }
            }
            await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { planId: 'training', status: 'active', validUntil: endsAt })
            await tx.event({ manager, platformId: account.id, event: 'training.activated', payload: { trainingId: record.id, enrollmentId: input.enrollmentId, tier: input.tier, operatorIdentityId: actor.identityId } })
            return record
        } })
    }

    async function revoke({ actor, enrollmentId }: { actor: HostingActor, enrollmentId: string }): Promise<void> {
        await tx.run({ dataSource, manager: existingManager, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const peek = await manager.getRepository(HostingTrainingEntity).findOneBy({ enrollmentId })
            if (!peek) hostingFail('HOSTING_TRAINING_NOT_FOUND')
            const account = await tx.account({ manager, platformId: peek.platformId })
            const record = await manager.getRepository(HostingTrainingEntity).findOneByOrFail({ id: peek.id })
            if (record.revokedAt) return
            const now = await tx.now(manager)
            await manager.getRepository(HostingTrainingEntity).update({ id: record.id }, { revokedAt: now })
            const grants = await manager.getRepository(HostingGrantEntity).findBy({ platformId: account.id })
            for (const grant of grants.filter(value => value.sourceKey.startsWith(`training:${record.id}:`) && !value.revokedAt)) {
                await manager.getRepository(HostingGrantEntity).update({ id: grant.id }, { revokedAt: now })
                const available = grant.amount - grant.reserved - grant.consumed
                await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: account.id, grantId: grant.id, reservationId: null, operation: 'revoke', key: `revoke:${grant.id}`, amount: available > 0n ? available : 0n })
            }
            if (account.planId === 'training') await manager.getRepository(HostingAccountEntity).update({ id: account.id }, { validUntil: now })
            await tx.event({ manager, platformId: account.id, event: 'training.revoked', payload: { trainingId: record.id, enrollmentId, operatorIdentityId: actor.identityId } })
        } })
    }
    return { activate, revoke }
}
