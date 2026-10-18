import { HostedPlanId } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type AllowanceGrantSnapshot = {
    grantId: string
    sourceKey: string
    planId: HostedPlanId
    validFrom: string
    validUntil: string
    previousAmountMicroUsd: string
    amountMicroUsd: string
    consumedMicroUsd: string
    reservedMicroUsd: string
}
export type HostingAiAllowanceChange = {
    id: string
    created: Date
    updated: Date
    platformId: string
    revision: number
    operatorIdentityId: string
    requestKey: string
    payloadHash: string
    monthlyCredits: number | null
    previousMonthlyCredits: number | null
    reason: string | null
    grantSnapshots: AllowanceGrantSnapshot[]
}
export type HostingAiAllowanceBinding = { id: string, created: Date, updated: Date, platformId: string, revision: number, changeId: string }
const credits = { type: Number, nullable: true }
const accountKey = { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' as const }
export const HostingAiAllowanceChangeEntity = new EntitySchema<HostingAiAllowanceChange>({
    name: 'hosting_ai_allowance_change', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, revision: { type: Number }, operatorIdentityId: ApIdSchema,
        requestKey: { type: String, length: 100 }, payloadHash: { type: String, length: 64 }, monthlyCredits: credits, previousMonthlyCredits: credits,
        reason: { type: String, length: 500, nullable: true }, grantSnapshots: { type: 'jsonb' },
    },
    uniques: [{ name: 'uq_hosting_ai_allowance_actor_request', columns: ['operatorIdentityId', 'requestKey'] }, { columns: ['platformId', 'revision'] }, { columns: ['id', 'platformId', 'revision'] }],
    checks: [{ expression: 'revision BETWEEN 1 AND 1000' }, { expression: '("monthlyCredits" IS NULL OR "monthlyCredits" BETWEEN 0 AND 1000000) AND ("previousMonthlyCredits" IS NULL OR "previousMonthlyCredits" BETWEEN 0 AND 1000000)' }, { expression: 'jsonb_typeof("grantSnapshots") = \'array\' AND jsonb_array_length("grantSnapshots") <= 256 AND octet_length("grantSnapshots"::text) <= 262144' }],
    foreignKeys: [accountKey],
})
export const HostingAiAllowanceBindingEntity = new EntitySchema<HostingAiAllowanceBinding>({
    name: 'hosting_ai_allowance_binding', columns: { ...BaseColumnSchemaPart, platformId: ApIdSchema, revision: { type: Number }, changeId: ApIdSchema },
    uniques: [{ columns: ['platformId'] }], checks: [{ expression: 'revision BETWEEN 1 AND 1000' }],
    foreignKeys: [accountKey, { target: 'hosting_ai_allowance_change', columnNames: ['changeId', 'platformId', 'revision'], referencedColumnNames: ['id', 'platformId', 'revision'], onDelete: 'RESTRICT' }],
})
export const HOSTING_AI_ALLOWANCE_ENTITIES = [HostingAiAllowanceChangeEntity, HostingAiAllowanceBindingEntity]
