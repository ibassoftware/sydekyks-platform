import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type HostingChargeResolution = {
    id: string
    created: Date
    updated: Date
    platformId: string
    callId: string
    rootReservationId: string
    revision: number
    operatorIdentityId: string
    operatorPlatformId: string
    operatorUserId: string
    requestKey: string
    requestHash: string
    beforeHash: string
    outcome: 'verified_usage' | 'confirmed_not_sent' | 'retain'
    reason: string
    evidenceReference: string
    supplierRequestId: string | null
    snapshot: Record<string, unknown>
    result: Record<string, unknown>
}
export const HostingChargeResolutionEntity = new EntitySchema<HostingChargeResolution>({
    name: 'hosting_charge_resolution', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, callId: ApIdSchema, rootReservationId: ApIdSchema,
        revision: { type: Number }, operatorIdentityId: ApIdSchema, operatorPlatformId: ApIdSchema, operatorUserId: ApIdSchema,
        requestKey: { type: String, length: 100 }, requestHash: { type: String, length: 64 }, beforeHash: { type: String, length: 64 },
        outcome: { type: String }, reason: { type: String, length: 1000 }, evidenceReference: { type: String, length: 1000 },
        supplierRequestId: { type: String, length: 200, nullable: true }, snapshot: { type: 'jsonb' }, result: { type: 'jsonb' },
    },
    uniques: [{ name: 'uq_hosting_resolution_actor_request', columns: ['operatorIdentityId', 'requestKey'] }, { columns: ['callId', 'revision'] }],
    foreignKeys: [
        { target: 'hosting_model_call', columnNames: ['callId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'hosting_reservation', columnNames: ['rootReservationId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
        { target: 'user_identity', columnNames: ['operatorIdentityId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
    ],
})
export const HOSTING_CHARGE_RESOLUTION_ENTITIES = [HostingChargeResolutionEntity]
