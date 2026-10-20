import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

const time = { type: 'timestamp with time zone' as const }
export type HostingSubscription = {
    id: string
    created: Date
    updated: Date
    revision: number
    renewalDueAt: Date | null
    planId: 'training' | 'starter' | 'team' | 'scale'
    entitlementId: string
    sourceKey: string
    accountValidUntil: Date
    validFrom: Date
    originalValidUntil: Date
    executionGrantId: string
    managedAiGrantId: string
}
export type HostingSubscriptionContext = { policy: HostingSubscription | null, bindingValid: boolean, revision: number, origin: 'fixed' | 'paid_default' | 'override' }
export type HostingSubscriptionCommand = {
    id: string
    created: Date
    updated: Date
    platformId: string
    actorIdentityId: string
    requestKey: string
    payloadHash: string
    revision: number
    reason: string
    snapshot: Record<string, unknown>
}
export const HostingSubscriptionEntity = new EntitySchema<HostingSubscription>({
    name: 'hosting_subscription', columns: {
        ...BaseColumnSchemaPart, revision: { type: Number }, renewalDueAt: { ...time, nullable: true },
        planId: { type: String }, entitlementId: ApIdSchema, sourceKey: { type: String, length: 180 },
        accountValidUntil: time, validFrom: time, originalValidUntil: time,
        executionGrantId: ApIdSchema, managedAiGrantId: ApIdSchema,
    },
    checks: [{ expression: 'revision > 0' }, { expression: '"planId" IN (\'training\',\'starter\',\'team\',\'scale\')' }, { expression: '"originalValidUntil" > "validFrom"' }],
    foreignKeys: [
        { target: 'hosting_account', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'hosting_grant', columnNames: ['executionGrantId', 'id'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
        { target: 'hosting_grant', columnNames: ['managedAiGrantId', 'id'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
    ],
})
export const HostingSubscriptionCommandEntity = new EntitySchema<HostingSubscriptionCommand>({
    name: 'hosting_subscription_command', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, actorIdentityId: ApIdSchema,
        requestKey: { type: String, length: 100 }, payloadHash: { type: String, length: 64 },
        revision: { type: Number }, reason: { type: String, length: 500 }, snapshot: { type: 'jsonb' },
    },
    uniques: [{ columns: ['actorIdentityId', 'requestKey'] }, { columns: ['platformId', 'revision'] }],
    foreignKeys: [{ target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HOSTING_SUBSCRIPTION_ENTITIES = [HostingSubscriptionEntity, HostingSubscriptionCommandEntity]
