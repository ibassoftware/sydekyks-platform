import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type Base = { id: string, created: Date, updated: Date }
export type ManualPlan = 'training' | 'starter' | 'team' | 'scale'
export type HostingManualAccount = Base & {
    identityId: string
    kind: 'partner' | 'client'
    package: 'core' | 'launch' | null
    enrollmentId: string | null
    termId: string
    revision: number
}
export type HostingManualTerm = Base & {
    platformId: string
    identityId: string
    planId: ManualPlan
    revision: number
    startsAt: Date
    expiresAt: Date
    monthlyCredits: number
    operatorIdentityId: string
    reason: string
}
export type HostingManualCommand = Base & {
    operatorIdentityId: string
    requestKey: string
    payloadHash: string
    action: 'create' | 'renew' | 'enroll'
    platformId: string
    termId: string
    snapshot: Record<string, unknown>
}
const accountFk = { target: 'hosting_account', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' as const }
export const HostingManualAccountEntity = new EntitySchema<HostingManualAccount>({
    name: 'hosting_manual_account', columns: {
        ...BaseColumnSchemaPart, identityId: { ...ApIdSchema, unique: true }, kind: { type: String }, package: { type: String, nullable: true },
        enrollmentId: { ...ApIdSchema, nullable: true }, termId: ApIdSchema, revision: { type: Number },
    },
    foreignKeys: [accountFk, { target: 'user_identity', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'hosting_manual_term', columnNames: ['termId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HostingManualTermEntity = new EntitySchema<HostingManualTerm>({
    name: 'hosting_manual_term', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, identityId: ApIdSchema, planId: { type: String }, revision: { type: Number },
        startsAt: { type: 'timestamptz' }, expiresAt: { type: 'timestamptz' }, monthlyCredits: { type: Number }, operatorIdentityId: ApIdSchema, reason: { type: String, length: 500 },
    },
    uniques: [{ columns: ['platformId', 'revision'] }],
    foreignKeys: [{ target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'user_identity', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HostingManualCommandEntity = new EntitySchema<HostingManualCommand>({
    name: 'hosting_manual_command', columns: {
        ...BaseColumnSchemaPart, operatorIdentityId: ApIdSchema, requestKey: { type: String, length: 100 }, payloadHash: { type: String, length: 64 }, action: { type: String }, platformId: ApIdSchema, termId: ApIdSchema, snapshot: { type: 'jsonb' },
    },
    uniques: [{ name: 'uq_manual_command_actor_request', columns: ['operatorIdentityId', 'requestKey'] }],
    foreignKeys: [{ target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'hosting_manual_term', columnNames: ['termId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HOSTING_MANUAL_ACCOUNT_ENTITIES = [HostingManualAccountEntity, HostingManualTermEntity, HostingManualCommandEntity]
