import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type Base = { id: string, created: Date, updated: Date }
export type RecoveryBinding = Base & { revision: number }
export type RecoveryToken = Base & {
    identityId: string
    identityEmail: string
    identityTokenVersion: string | null
    operatorIdentityId: string
    operatorPlatformId: string
    operatorTokenVersion: string | null
    revision: number
    requestKey: string
    requestHash: string
    action: 'issue' | 'revoke'
    tokenDigest: string | null
    expiresAt: Date
    usedAt: Date | null
    revokedAt: Date | null
    method: 'manual_recovery'
    emailOwnershipVerified: false
    verificationReason: string
    verificationEvidence: string
}
const nullableDate = { type: 'timestamp with time zone' as const, nullable: true }
export const HostingRecoveryBindingEntity = new EntitySchema<RecoveryBinding>({ name: 'hosting_recovery_binding', columns: { ...BaseColumnSchemaPart, revision: { type: Number } }, foreignKeys: [{ target: 'user_identity', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }] })
export const HostingRecoveryTokenEntity = new EntitySchema<RecoveryToken>({
    name: 'hosting_recovery_token',
    columns: {
        ...BaseColumnSchemaPart, identityId: ApIdSchema, identityEmail: { type: String }, identityTokenVersion: { type: String, nullable: true },
        operatorIdentityId: ApIdSchema, operatorPlatformId: ApIdSchema, operatorTokenVersion: { type: String, nullable: true },
        revision: { type: Number }, requestKey: { type: String, length: 100 }, requestHash: { type: String, length: 64 }, action: { type: String },
        tokenDigest: { type: String, length: 64, nullable: true, unique: true }, expiresAt: { type: 'timestamp with time zone' }, usedAt: nullableDate, revokedAt: nullableDate,
        method: { type: String }, emailOwnershipVerified: { type: Boolean }, verificationReason: { type: String, length: 1000 }, verificationEvidence: { type: String, length: 1000 },
    },
    uniques: [{ name: 'uq_recovery_actor_request', columns: ['operatorIdentityId', 'requestKey'] }, { columns: ['identityId', 'revision'] }],
    foreignKeys: [{ target: 'user_identity', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'user_identity', columnNames: ['operatorIdentityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HOSTING_RECOVERY_ENTITIES = [HostingRecoveryBindingEntity, HostingRecoveryTokenEntity]
