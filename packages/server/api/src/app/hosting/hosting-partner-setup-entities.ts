import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type Base = { id: string, created: Date, updated: Date }
export type PartnerSetupBinding = Base & { revision: number }
export type PartnerSetupToken = Base & {
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
    method: 'operator'
    emailOwnershipVerified: false
}
const nullableDate = { type: 'timestamp with time zone' as const, nullable: true }
export const HostingPartnerSetupBindingEntity = new EntitySchema<PartnerSetupBinding>({ name: 'hosting_partner_setup_binding', columns: { ...BaseColumnSchemaPart, revision: { type: Number } }, foreignKeys: [{ target: 'user_identity', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }] })
export const HostingPartnerSetupTokenEntity = new EntitySchema<PartnerSetupToken>({
    name: 'hosting_partner_setup_token',
    columns: {
        ...BaseColumnSchemaPart, identityId: ApIdSchema, identityEmail: { type: String }, identityTokenVersion: { type: String, nullable: true },
        operatorIdentityId: ApIdSchema, operatorPlatformId: ApIdSchema, operatorTokenVersion: { type: String, nullable: true },
        revision: { type: Number }, requestKey: { type: String, length: 100 }, requestHash: { type: String, length: 64 }, action: { type: String },
        tokenDigest: { type: String, length: 64, nullable: true, unique: true }, expiresAt: { type: 'timestamp with time zone' }, usedAt: nullableDate, revokedAt: nullableDate,
        method: { type: String }, emailOwnershipVerified: { type: Boolean },
    },
    uniques: [{ name: 'uq_partner_setup_actor_request', columns: ['operatorIdentityId', 'requestKey'] }, { columns: ['identityId', 'revision'] }],
    foreignKeys: [{ target: 'user_identity', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'user_identity', columnNames: ['operatorIdentityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HOSTING_PARTNER_SETUP_ENTITIES = [HostingPartnerSetupBindingEntity, HostingPartnerSetupTokenEntity]
