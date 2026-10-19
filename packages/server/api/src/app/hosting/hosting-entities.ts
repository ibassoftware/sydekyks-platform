import { HostedPlanId, PlatformRole } from '@activepieces/shared'
import { EntitySchema, EntitySchemaColumnOptions, EntitySchemaOptions } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'
import type { HostingSubscriptionContext } from './hosting-subscription-entities'

function fromQuantity(value: unknown): bigint | null {
    if (value === null) return null
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error('HOSTING_INVALID_STORED_QUANTITY')
    return BigInt(value)
}

const quantity = { type: 'numeric', precision: 30, scale: 0, default: '0', transformer: { to: (value: bigint | null | undefined) => value?.toString() ?? value, from: fromQuantity } } satisfies EntitySchemaColumnOptions
const timestamp = { type: 'timestamp with time zone' } satisfies EntitySchemaColumnOptions
const accountForeignKey = { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' } satisfies NonNullable<EntitySchemaOptions<unknown>['foreignKeys']>[number]

export const HostingAccountEntity = new EntitySchema<HostingAccount>({
    name: 'hosting_account', columns: {
        ...BaseColumnSchemaPart, ownerIdentityId: ApIdSchema, initialProjectId: ApIdSchema,
        status: { type: String }, planId: { type: String }, catalogVersion: { type: String },
        trialStartedAt: timestamp, trialEndsAt: timestamp, validUntil: timestamp,
        activeExecutions: { type: Number, default: 0 }, billingHold: { type: Boolean, default: false },
    },
    checks: [{ expression: '"activeExecutions" >= 0' }, { expression: '"status" IN (\'trialing\', \'active\', \'suspended\')' }, { name: 'CHK_7a22f26b8fb98d989a5326db4b', expression: '"planId" IN (\'trial\', \'training\', \'assessment\', \'starter\', \'team\')' }],
    foreignKeys: [{ target: 'platform', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})

export const HostingEligibilityEntity = new EntitySchema<HostingEligibility>({
    name: 'hosting_eligibility', columns: {
        ...BaseColumnSchemaPart, id: { type: String, length: 64, primary: true }, identityId: ApIdSchema, platformId: ApIdSchema,
    },
    uniques: [{ columns: ['identityId'] }, { columns: ['platformId'] }],
})

export const HostingPolicyEntity = new EntitySchema<HostingPolicy>({
    name: 'hosting_policy', columns: { ...BaseColumnSchemaPart, subjectKeyFingerprint: { type: String, length: 64 } },
})

export const HostingGrantEntity = new EntitySchema<HostingGrant>({
    name: 'hosting_grant', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, sourceKey: { type: String, length: 180 }, meter: { type: String },
        amount: quantity, reserved: quantity, consumed: quantity, validFrom: timestamp, validUntil: timestamp, revokedAt: { ...timestamp, nullable: true },
    },
    uniques: [{ columns: ['platformId', 'sourceKey', 'meter'] }, { columns: ['id', 'platformId'] }],
    checks: [{ expression: 'amount >= 0 AND reserved >= 0 AND consumed >= 0' }, { expression: '"validUntil" > "validFrom"' }, { expression: 'meter IN (\'execution\', \'managed_ai\')' }],
    foreignKeys: [accountForeignKey],
})

export const HostingReservationEntity = new EntitySchema<HostingReservation>({
    name: 'hosting_reservation', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, projectId: ApIdSchema, identityId: ApIdSchema, grantId: ApIdSchema,
        key: { type: String, length: 120 }, kind: { type: String }, payer: { type: String }, state: { type: String },
        rootReservationId: { ...ApIdSchema, nullable: true }, day: { type: String, length: 10, nullable: true },
        amount: quantity, actualAmount: { ...quantity, nullable: true, default: undefined },
        dispatchId: { ...ApIdSchema, nullable: true },
    },
    uniques: [{ columns: ['platformId', 'kind', 'key'] }, { columns: ['id', 'platformId'] }],
    indices: [{ columns: ['platformId', 'rootReservationId', 'state'] }],
    checks: [{ expression: 'amount > 0 AND ("actualAmount" IS NULL OR "actualAmount" >= 0)' }, { expression: 'state IN (\'reserved\', \'running\', \'settled\', \'released\', \'uncertain\', \'paused\')' }, { expression: 'kind IN (\'execution\', \'managed_ai\')' }, { expression: 'payer IN (\'managed\', \'byok\')' }],
    foreignKeys: [accountForeignKey,
        { target: 'hosting_grant', columnNames: ['grantId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
        { target: 'hosting_reservation', columnNames: ['rootReservationId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
    ],
})

export const HostingLedgerEntity = new EntitySchema<HostingLedgerEntry>({
    name: 'hosting_ledger', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, grantId: ApIdSchema,
        reservationId: { ...ApIdSchema, nullable: true }, operation: { type: String },
        key: { type: String, length: 180 }, amount: quantity,
    },
    uniques: [{ columns: ['platformId', 'key'] }],
    checks: [{ expression: 'amount >= 0' }],
    foreignKeys: [accountForeignKey,
        { target: 'hosting_grant', columnNames: ['grantId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
        { target: 'hosting_reservation', columnNames: ['reservationId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
    ],
})

export const HostingDailyBudgetEntity = new EntitySchema<HostingDailyBudget>({
    name: 'hosting_daily_budget', columns: {
        ...BaseColumnSchemaPart, id: { type: String, length: 10, primary: true }, reserved: quantity, consumed: quantity, limit: quantity,
    }, checks: [{ expression: 'reserved >= 0 AND consumed >= 0 AND "limit" >= 0' }],
})

export const HostingInvitationEntity = new EntitySchema<HostingInvitation>({
    name: 'hosting_invitation', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, subject: { type: String, length: 64 }, tokenDigest: { type: String, length: 64, unique: true },
        role: { type: String }, status: { type: String }, expiresAt: timestamp, projectUnits: { type: Number, default: 1 },
        acceptedIdentityId: { ...ApIdSchema, nullable: true },
    },
    indices: [{ columns: ['platformId', 'subject'], unique: true, where: 'status = \'pending\'' }],
    checks: [{ expression: '"projectUnits" IN (0, 1)' }, { expression: 'status IN (\'pending\', \'accepted\', \'revoked\')' }, { expression: 'role IN (\'ADMIN\', \'MEMBER\', \'OPERATOR\')' }],
    foreignKeys: [accountForeignKey],
})

export const HostingOutboxEntity = new EntitySchema<HostingOutboxEvent>({
    name: 'hosting_outbox', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, event: { type: String }, payload: { type: 'jsonb' }, processedAt: { ...timestamp, nullable: true },
    }, foreignKeys: [accountForeignKey],
})

export const HOSTING_ENTITIES = [HostingAccountEntity, HostingEligibilityEntity, HostingPolicyEntity, HostingGrantEntity, HostingReservationEntity, HostingLedgerEntity, HostingDailyBudgetEntity, HostingInvitationEntity, HostingOutboxEntity]

type HostingBase = { id: string, created: Date, updated: Date }
export type HostingAccount = HostingBase & { ownerIdentityId: string, initialProjectId: string, status: 'trialing' | 'active' | 'suspended', planId: HostedPlanId, catalogVersion: string, trialStartedAt: Date, trialEndsAt: Date, validUntil: Date, activeExecutions: number, billingHold?: boolean, subscription?: HostingSubscriptionContext }
export type HostingEligibility = HostingBase & { identityId: string, platformId: string }
export type HostingPolicy = HostingBase & { subjectKeyFingerprint: string }
export type HostingMeter = 'execution' | 'managed_ai'
export type HostingGrant = HostingBase & { platformId: string, sourceKey: string, meter: HostingMeter, amount: bigint, reserved: bigint, consumed: bigint, validFrom: Date, validUntil: Date, revokedAt?: Date | null }
export type HostingReservation = HostingBase & { platformId: string, projectId: string, identityId: string, grantId: string, key: string, kind: HostingMeter, payer: 'managed' | 'byok', state: 'reserved' | 'running' | 'settled' | 'released' | 'uncertain' | 'paused', rootReservationId: string | null, day: string | null, amount: bigint, actualAmount: bigint | null, dispatchId: string | null }
export type HostingLedgerEntry = HostingBase & { platformId: string, grantId: string, reservationId: string | null, operation: 'grant' | 'reserve' | 'dispatch' | 'settle' | 'release' | 'uncertain' | 'revoke', key: string, amount: bigint }
export type HostingDailyBudget = HostingBase & { reserved: bigint, consumed: bigint, limit: bigint }
export type HostingInvitation = HostingBase & { platformId: string, subject: string, tokenDigest: string, role: PlatformRole, projectUnits: number, status: 'pending' | 'accepted' | 'revoked', expiresAt: Date, acceptedIdentityId: string | null }
export type HostingOutboxEvent = HostingBase & { platformId: string, event: string, payload: Record<string, unknown>, processedAt: Date | null }
