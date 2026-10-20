import { HostedPlanId } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type CreditAllowanceSnapshot = { grantId: string, sourceKey: string, planId: HostedPlanId, validFrom: string, validUntil: string, previousAmount: string, amount: string, consumed: string, reserved: string }
export type HostingCreditAllowanceChange = { id: string, created: Date, updated: Date, platformId: string, revision: number, operatorIdentityId: string, requestKey: string, payloadHash: string, monthlyCredits: number | null, previousMonthlyCredits: number | null, reason: string, grantSnapshots: CreditAllowanceSnapshot[] }
export type HostingCreditAllowanceBinding = { id: string, created: Date, updated: Date, platformId: string, revision: number, changeId: string }
const credits = { type: Number, nullable: true }
const accountKey = { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' as const }
export const HostingCreditAllowanceChangeEntity = new EntitySchema<HostingCreditAllowanceChange>({
    name: 'hosting_credit_allowance_change', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, revision: { type: Number }, operatorIdentityId: ApIdSchema,
        requestKey: { type: String, length: 100 }, payloadHash: { type: String, length: 64 }, monthlyCredits: credits, previousMonthlyCredits: credits,
        reason: { type: String, length: 500 }, grantSnapshots: { type: 'jsonb' },
    },
    uniques: [{ name: 'uq_hosting_credit_allowance_actor_request', columns: ['operatorIdentityId', 'requestKey'] }, { columns: ['platformId', 'revision'] }, { columns: ['id', 'platformId', 'revision'] }],
    checks: [{ expression: 'revision BETWEEN 1 AND 1000' }, { expression: '("monthlyCredits" IS NULL OR "monthlyCredits" BETWEEN 0 AND 1000000) AND ("previousMonthlyCredits" IS NULL OR "previousMonthlyCredits" BETWEEN 0 AND 1000000)' }, { expression: 'jsonb_typeof("grantSnapshots") = \'array\' AND jsonb_array_length("grantSnapshots") <= 256 AND octet_length("grantSnapshots"::text) <= 262144' }],
    foreignKeys: [accountKey],
})
export const HostingCreditAllowanceBindingEntity = new EntitySchema<HostingCreditAllowanceBinding>({
    name: 'hosting_credit_allowance_binding', columns: { ...BaseColumnSchemaPart, platformId: ApIdSchema, revision: { type: Number }, changeId: ApIdSchema },
    uniques: [{ columns: ['platformId'] }], checks: [{ expression: 'revision BETWEEN 1 AND 1000' }],
    foreignKeys: [accountKey, { target: 'hosting_credit_allowance_change', columnNames: ['changeId', 'platformId', 'revision'], referencedColumnNames: ['id', 'platformId', 'revision'], onDelete: 'RESTRICT' }],
})
export const HOSTING_CREDIT_ALLOWANCE_ENTITIES = [HostingCreditAllowanceChangeEntity, HostingCreditAllowanceBindingEntity]
