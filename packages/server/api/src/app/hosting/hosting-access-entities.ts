import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type AccessBase = { id: string, created: Date, updated: Date }
export type HostingAccessRole = AccessBase & { role: 'partner' | 'team', active: boolean }
export type HostingAccessMembership = AccessBase & { platformId: string, identityId: string, userId: string, role: 'partner' | 'team', active: boolean }

export const HostingAccessRoleEntity = new EntitySchema<HostingAccessRole>({
    name: 'hosting_access_role',
    columns: { ...BaseColumnSchemaPart, role: { type: String }, active: { type: Boolean } },
    checks: [{ expression: 'role IN (\'partner\', \'team\')' }],
    foreignKeys: [{ target: 'user_identity', columnNames: ['id'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
export const HostingAccessMembershipEntity = new EntitySchema<HostingAccessMembership>({
    name: 'hosting_access_membership',
    columns: { ...BaseColumnSchemaPart, platformId: ApIdSchema, identityId: ApIdSchema, userId: ApIdSchema, role: { type: String }, active: { type: Boolean } },
    uniques: [{ columns: ['platformId', 'identityId'] }, { columns: ['userId'] }],
    checks: [{ expression: 'role IN (\'partner\', \'team\')' }],
    foreignKeys: [
        { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'hosting_access_role', columnNames: ['identityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'user', columnNames: ['userId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
    ],
})
export const HOSTING_ACCESS_ENTITIES = [HostingAccessRoleEntity, HostingAccessMembershipEntity]
