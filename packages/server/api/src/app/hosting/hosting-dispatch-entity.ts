import { EngineResponseStatus, FlowRunStatus, JobData } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export const HostingDispatchEntity = new EntitySchema<HostingDispatch>({
    name: 'hosting_dispatch', columns: {
        ...BaseColumnSchemaPart, platformId: ApIdSchema, projectId: ApIdSchema, identityId: ApIdSchema,
        tokenVersion: { type: String, nullable: true }, originType: { type: String }, queueKey: { type: String, length: 64 }, payloadHash: { type: String, length: 64 },
        state: { type: String }, rootKey: { type: String, length: 120 }, reservationId: { ...ApIdSchema, nullable: true },
        admissionId: { ...ApIdSchema, nullable: true }, dispatchId: { ...ApIdSchema, nullable: true },
        queueTokenHash: { type: String, length: 64, nullable: true }, connectionId: { type: String, nullable: true },
        rootDispatchId: { ...ApIdSchema, nullable: true }, parentDispatchId: { ...ApIdSchema, nullable: true }, generation: { type: Number, default: 0 },
        waitpointId: { ...ApIdSchema, nullable: true }, callbackWaitpointId: { ...ApIdSchema, nullable: true }, resolutionStatus: { type: String, nullable: true },
        checkpoint: { type: 'jsonb', nullable: true }, requestHash: { type: String, nullable: true },
        queueName: { type: String, nullable: true }, jobId: { type: String, nullable: true }, payload: { type: 'jsonb', nullable: true },
        availableAt: { type: 'timestamp with time zone', nullable: true }, leaseUntil: { type: 'timestamp with time zone', nullable: true }, publishedAt: { type: 'timestamp with time zone', nullable: true },
        flowRunId: { ...ApIdSchema, nullable: true }, terminalReceipt: { type: String, nullable: true }, completionStatus: { type: String, nullable: true },
    },
    indices: [{ name: 'idx_hosting_dispatch_queue', columns: ['queueKey'], unique: true }, { name: 'idx_hosting_dispatch_admission', columns: ['admissionId'], unique: true }, { name: 'idx_hosting_dispatch_root', columns: ['platformId', 'rootKey'], unique: true }],
    uniques: [{ name: 'uq_hosting_dispatch_scope', columns: ['id', 'platformId'] }, { name: 'uq_hosting_dispatch_generation', columns: ['platformId', 'flowRunId', 'generation'] }],
    checks: [{ expression: 'generation >= 0' }, { name: 'chk_hosting_dispatch_state', expression: 'state IN (\'prepared\', \'admitted\', \'running\', \'completed\', \'uncertain\', \'cancelled\', \'paused\')' }],
    foreignKeys: [
        { target: 'hosting_dispatch', columnNames: ['rootDispatchId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
        { target: 'hosting_dispatch', columnNames: ['parentDispatchId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
        { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'hosting_reservation', columnNames: ['reservationId', 'platformId'], referencedColumnNames: ['id', 'platformId'], onDelete: 'RESTRICT' },
    ],
})

export type HostingDispatch = { id: string, created: Date, updated: Date, platformId: string, projectId: string, identityId: string, tokenVersion: string | null, originType: 'scheduled' | 'user', queueKey: string, payloadHash: string, state: 'prepared' | 'admitted' | 'running' | 'completed' | 'uncertain' | 'cancelled' | 'paused', rootKey: string, reservationId: string | null, admissionId: string | null, dispatchId: string | null, queueTokenHash: string | null, connectionId: string | null, rootDispatchId: string | null, parentDispatchId: string | null, generation: number, waitpointId: string | null, callbackWaitpointId: string | null, resolutionStatus: FlowRunStatus | null, checkpoint: Record<string, unknown> | null, requestHash: string | null, queueName: string | null, jobId: string | null, payload: JobData | null, availableAt: Date | null, leaseUntil: Date | null, publishedAt: Date | null, flowRunId: string | null, terminalReceipt: FlowRunStatus | null, completionStatus: EngineResponseStatus | null }
