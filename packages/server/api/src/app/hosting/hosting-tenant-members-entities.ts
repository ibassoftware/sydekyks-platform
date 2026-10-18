import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type Base = { id: string, created: Date, updated: Date }
export type TenantMembersBinding = Base & { revision: number }
export type TenantMembersCommand = Base & { platformId: string, identityId: string, identityEmail: string, identityTokenVersion: string | null, actorIdentityId: string, actorTokenVersion: string | null, revision: number, requestKey: string, requestHash: string, action: 'invite' | 'revoke' | 'change', invitationId: string | null, mode: 'setup' | 'existing' | null, usedAt: Date | null }
export const HostingTenantMembersBindingEntity = new EntitySchema<TenantMembersBinding>({ name: 'hosting_tenant_members_binding', columns: { ...BaseColumnSchemaPart, revision: { type: Number } }, foreignKeys: [{ target: 'hosting_account', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }] })
export const HostingTenantMembersCommandEntity = new EntitySchema<TenantMembersCommand>({
    name: 'hosting_tenant_members_command', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, identityId: ApIdSchema, identityEmail: { type: String }, identityTokenVersion: { type: String, nullable: true }, actorIdentityId: ApIdSchema, actorTokenVersion: { type: String, nullable: true }, revision: { type: Number }, requestKey: { type: String, length: 100 }, requestHash: { type: String, length: 64 }, action: { type: String }, invitationId: { ...ApIdSchema, nullable: true }, mode: { type: String, nullable: true }, usedAt: { type: 'timestamp with time zone', nullable: true },
    }, uniques: [{ columns: ['platformId', 'actorIdentityId', 'requestKey'] }, { columns: ['platformId', 'revision'] }, { columns: ['invitationId'] }],
    foreignKeys: [{ target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'user_identity', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'hosting_invitation', columnNames: ['invitationId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HOSTING_TENANT_MEMBERS_ENTITIES = [HostingTenantMembersBindingEntity, HostingTenantMembersCommandEntity]
