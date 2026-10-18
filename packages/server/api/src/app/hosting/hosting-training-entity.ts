import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type HostingTraining = {
    id: string
    created: Date
    updated: Date
    platformId: string
    identityId: string
    enrollmentId: string
    receiptId: string
    tier: 'core' | 'launch'
    operatorIdentityId: string
    startsAt: Date
    endsAt: Date
    revokedAt: Date | null
}

// Immutable receipt binding: a replay never restarts the clock or mints another allowance.
export const HostingTrainingEntity = new EntitySchema<HostingTraining>({
    name: 'hosting_training',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: ApIdSchema, identityId: ApIdSchema, enrollmentId: ApIdSchema,
        receiptId: { type: String, length: 180 }, tier: { type: String }, operatorIdentityId: ApIdSchema,
        startsAt: { type: 'timestamp with time zone' }, endsAt: { type: 'timestamp with time zone' },
        revokedAt: { type: 'timestamp with time zone', nullable: true },
    },
    uniques: [{ columns: ['platformId'] }, { columns: ['enrollmentId'] }, { columns: ['receiptId'] }],
    checks: [{ expression: 'tier IN (\'core\', \'launch\')' }, { expression: '"endsAt" > "startsAt"' }],
    foreignKeys: [{ target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }],
})
