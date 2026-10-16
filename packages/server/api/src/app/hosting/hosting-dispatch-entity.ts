import { EngineResponseStatus, FlowRunStatus } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export const HostingDispatchEntity = new EntitySchema<HostingDispatch>({
    name: 'hosting_dispatch', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, projectId: ApIdSchema, identityId: ApIdSchema,
        tokenVersion: { type: String, nullable: true }, originType: { type: String }, queueKey: { type: String, length: 64 }, payloadHash: { type: String, length: 64 },
        state: { type: String }, rootKey: { type: String, length: 120 }, reservationId: { ...ApIdSchema, nullable: true },
        admissionId: { ...ApIdSchema, nullable: true }, dispatchId: { ...ApIdSchema, nullable: true },
        queueTokenHash: { type: String, length: 64, nullable: true }, connectionId: { type: String, nullable: true },
        flowRunId: { ...ApIdSchema, nullable: true }, terminalReceipt: { type: String, nullable: true }, completionStatus: { type: String, nullable: true },
    },
    indices: [{ name: 'idx_hosting_dispatch_queue', columns: ['queueKey'], unique: true }, { name: 'idx_hosting_dispatch_admission', columns: ['admissionId'], unique: true }, { name: 'idx_hosting_dispatch_root', columns: ['platformId', 'rootKey'], unique: true }],
    checks: [{ name: 'chk_hosting_dispatch_state', expression: 'state IN (\'prepared\', \'admitted\', \'running\', \'completed\', \'uncertain\', \'cancelled\')' }],
    foreignKeys: [
        { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'hosting_reservation', columnNames: ['reservationId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
    ],
})

export type HostingDispatch = { id: string, created: Date, updated: Date, platformId: string, projectId: string, identityId: string, tokenVersion: string | null, originType: 'scheduled' | 'user', queueKey: string, payloadHash: string, state: 'prepared' | 'admitted' | 'running' | 'completed' | 'uncertain' | 'cancelled', rootKey: string, reservationId: string | null, admissionId: string | null, dispatchId: string | null, queueTokenHash: string | null, connectionId: string | null, flowRunId: string | null, terminalReceipt: FlowRunStatus | null, completionStatus: EngineResponseStatus | null }
