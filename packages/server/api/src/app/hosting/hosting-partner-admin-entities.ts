import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type Base = { id: string, created: Date, updated: Date }
export type PartnerAdminBinding = Base & { revision: number }
export type PartnerAdminCommand = Base & { identityId: string, revision: number, operatorIdentityId: string, requestKey: string, payloadHash: string, action: string, platformId: string | null }
export const HostingPartnerAdminBindingEntity = new EntitySchema<PartnerAdminBinding>({
    name: 'hosting_partner_admin_binding', columns: { ...BaseColumnSchemaPart, revision: { type: Number } },
    foreignKeys: [{ target: 'user_identity', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
    checks: [{ expression: 'revision BETWEEN 0 AND 1000' }],
})
export const HostingPartnerAdminCommandEntity = new EntitySchema<PartnerAdminCommand>({
    name: 'hosting_partner_admin_command',
    columns: { ...BaseColumnSchemaPart, identityId: ApIdSchema, revision: { type: Number }, operatorIdentityId: ApIdSchema, requestKey: { type: String, length: 100 }, payloadHash: { type: String, length: 64 }, action: { type: String }, platformId: { ...ApIdSchema, nullable: true } },
    uniques: [{ name: 'uq_partner_admin_actor_request', columns: ['operatorIdentityId', 'requestKey'] }, { columns: ['identityId', 'revision'] }],
    foreignKeys: [{ target: 'user_identity', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'user_identity', columnNames: ['operatorIdentityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
    checks: [{ expression: 'revision BETWEEN 1 AND 1000' }, { expression: 'action IN (\'approve\',\'deactivate\',\'assign\',\'unassign\')' }],
})
export const HOSTING_PARTNER_ADMIN_ENTITIES = [HostingPartnerAdminBindingEntity, HostingPartnerAdminCommandEntity]
