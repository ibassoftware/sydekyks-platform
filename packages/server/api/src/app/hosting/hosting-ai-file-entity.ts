import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type HostedAiFile = {
    id: string
    created: Date
    updated: Date
    platformId: string
    projectId: string
    identityId: string
    name: string
    mimeType: string
    size: number
    storedBytes: number
    kind: 'text' | 'image' | 'document'
    pageCount: number
    inputTokenBound: number
    contentHash: string
    processorVersion: string
    cacheKey: string | null
    state: 'ready' | 'deleted' | 'expired'
    expiresAt: Date
    encryptedData: Buffer | null
}

export const HostedAiFileEntity = new EntitySchema<HostedAiFile>({
    name: 'hosting_ai_file',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: ApIdSchema,
        projectId: ApIdSchema,
        identityId: ApIdSchema,
        name: { type: String, length: 160 },
        mimeType: { type: String, length: 100 },
        size: { type: Number },
        storedBytes: { type: Number },
        kind: { type: String, length: 16 },
        pageCount: { type: Number },
        inputTokenBound: { type: Number },
        contentHash: { type: String, length: 64 },
        processorVersion: { type: String, length: 80 },
        cacheKey: { type: String, length: 64, nullable: true, unique: true },
        state: { type: String, length: 16 },
        expiresAt: { type: 'timestamptz' },
        encryptedData: { type: 'bytea', nullable: true },
    },
    indices: [
        { name: 'idx_hosting_ai_file_project_identity', columns: ['projectId', 'identityId', 'state'] },
        { name: 'idx_hosting_ai_file_expiry', columns: ['state', 'expiresAt'] },
    ],
    checks: [{ expression: 'state IN (\'ready\', \'deleted\', \'expired\')' }, { expression: 'size > 0 AND size <= 20971520 AND "storedBytes" >= 0 AND "pageCount" >= 1 AND "pageCount" <= 20 AND "inputTokenBound" >= 0 AND "inputTokenBound" <= 40000' }],
    foreignKeys: [{ target: 'project', columnNames: ['projectId'], referencedColumnNames: ['id'], onDelete: 'CASCADE' }],
})
