import { EntitySchema, EntitySchemaColumnOptions } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

const quantity = { type: 'numeric', precision: 30, scale: 0, transformer: { to: (value: bigint): string => value.toString(), from: (value: string): bigint => BigInt(value) } } satisfies EntitySchemaColumnOptions

export type HostingRootCreditUsage = {
    id: string
    created: Date
    updated: Date
    platformId: string
    grantId: string
    microUsdPerCredit: bigint
    consumedCredits: bigint
    reservedCredits: bigint
    settledSupplierMicroUsd: bigint
    heldSupplierMicroUsd: bigint
    revision: number
}

export const HostingRootCreditUsageEntity = new EntitySchema<HostingRootCreditUsage>({
    name: 'hosting_root_credit_usage',
    columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, grantId: ApIdSchema,
        microUsdPerCredit: quantity, consumedCredits: quantity, reservedCredits: quantity,
        settledSupplierMicroUsd: quantity, heldSupplierMicroUsd: quantity, revision: { type: Number },
    },
    checks: [{ name: 'chk_hosting_root_credit_usage', expression: '"microUsdPerCredit">0 AND "consumedCredits">=0 AND "reservedCredits">=0 AND "settledSupplierMicroUsd">=0 AND "heldSupplierMicroUsd">=0 AND revision>=1' }],
    indices: [{ name: 'idx_hosting_root_credit_grant', columns: ['platformId', 'grantId'] }],
    foreignKeys: [
        { target: 'hosting_reservation', columnNames: ['id', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
        { target: 'hosting_grant', columnNames: ['grantId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
    ],
})
