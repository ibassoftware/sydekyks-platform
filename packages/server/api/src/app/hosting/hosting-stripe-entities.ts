import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

const text = { type: String }
const optional = { type: String, nullable: true }
const time = { type: 'timestamp with time zone' as const, nullable: true }
const accountKey = { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' as const }
export type StripeBinding = { id: string, created: Date, updated: Date, platformId: string, stripeAccountId: string, catalogHash: string, customerId: string | null, subscriptionId: string | null, subscriptionStatus: string | null, lastError: string | null, holds: string[], fence: string | null, leaseUntil: Date | null, reconcileAt: Date, revision: number }
export const HostingStripeBindingEntity = new EntitySchema<StripeBinding>({
    name: 'hosting_stripe_binding', columns: { ...BaseColumnSchemaPart, platformId: ApIdSchema, stripeAccountId: text, catalogHash: text, customerId: optional, subscriptionId: optional, subscriptionStatus: optional, lastError: optional, holds: { type: 'jsonb', default: () => '\'[]\'::jsonb' }, fence: optional, leaseUntil: time, reconcileAt: { type: 'timestamp with time zone' }, revision: { type: Number, default: 0 } },
    uniques: [{ columns: ['platformId'] }, { columns: ['stripeAccountId', 'customerId'] }], indices: [{ columns: ['reconcileAt'] }], foreignKeys: [accountKey],
})
export type StripeCommand = { id: string, created: Date, updated: Date, platformId: string, kind: 'customer' | 'checkout' | 'portal', state: 'prepared' | 'running' | 'uncertain' | 'ready' | 'closed', actorIdentityId: string, tokenVersion: string | null, payload: Record<string, unknown>, payloadHash: string, idempotencyKey: string, fence: string | null, firstSentAt: Date | null, leaseUntil: Date | null, objectId: string | null, url: string | null, expiresAt: Date | null }
export const HostingStripeCommandEntity = new EntitySchema<StripeCommand>({
    name: 'hosting_stripe_command', columns: { ...BaseColumnSchemaPart, platformId: ApIdSchema, kind: text, state: text, actorIdentityId: ApIdSchema, tokenVersion: optional, payload: { type: 'jsonb' }, payloadHash: text, idempotencyKey: text, fence: optional, firstSentAt: time, leaseUntil: time, objectId: optional, url: optional, expiresAt: time },
    indices: [{ name: 'uq_hosting_stripe_open_command', columns: ['platformId', 'kind'], unique: true, where: 'state <> \'closed\'' }], checks: [{ expression: 'kind IN (\'customer\',\'checkout\',\'portal\') AND state IN (\'prepared\',\'running\',\'uncertain\',\'ready\',\'closed\')' }], foreignKeys: [accountKey],
})
export type StripeInbox = { id: string, created: Date, updated: Date, stripeAccountId: string, eventId: string, eventType: string, rawHash: string, eventHash: string, objectId: string | null, customerId: string | null, chargeId: string | null, risk: boolean, state: 'pending' | 'processed' | 'ignored' | 'quarantined', availableAt: Date, reason: string | null }
export const HostingStripeInboxEntity = new EntitySchema<StripeInbox>({
    name: 'hosting_stripe_inbox', columns: { ...BaseColumnSchemaPart, stripeAccountId: text, eventId: text, eventType: text, rawHash: text, eventHash: text, objectId: optional, customerId: optional, chargeId: optional, risk: { type: Boolean, default: false }, state: text, availableAt: { type: 'timestamp with time zone' }, reason: optional },
    uniques: [{ columns: ['stripeAccountId', 'eventId'] }], indices: [{ columns: ['state', 'availableAt'] }], checks: [{ expression: 'state IN (\'pending\',\'processed\',\'ignored\',\'quarantined\')' }],
})
export type StripePeriod = { id: string, created: Date, updated: Date, platformId: string, stripeAccountId: string, customerId: string, subscriptionId: string, itemId: string, priceId: string, planId: 'starter' | 'team', sourceKey: string, periodStart: Date, periodEnd: Date, invoiceIds: string[], lineIds: string[], chargeIds: string[], revokedAt: Date | null }
export const HostingStripePeriodEntity = new EntitySchema<StripePeriod>({
    name: 'hosting_stripe_period', columns: { ...BaseColumnSchemaPart, platformId: ApIdSchema, stripeAccountId: text, customerId: text, subscriptionId: text, itemId: text, priceId: text, planId: text, sourceKey: text, periodStart: { type: 'timestamp with time zone' }, periodEnd: { type: 'timestamp with time zone' }, invoiceIds: { type: 'jsonb' }, lineIds: { type: 'jsonb' }, chargeIds: { type: 'jsonb' }, revokedAt: time },
    uniques: [{ columns: ['platformId', 'sourceKey'] }], checks: [{ expression: '"periodEnd" > "periodStart"' }], foreignKeys: [accountKey],
})
export const HOSTING_STRIPE_ENTITIES = [HostingStripeBindingEntity, HostingStripeCommandEntity, HostingStripeInboxEntity, HostingStripePeriodEntity]
