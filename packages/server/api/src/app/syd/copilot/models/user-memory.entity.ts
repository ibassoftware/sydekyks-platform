import { Platform, User, UserMemory } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../../database/database-common'

export const SydUserMemoryEntity = new EntitySchema<SydUserMemoryWithRelations>({
    name: 'syd_user_memory',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: { ...ApIdSchema, nullable: false },
        userId: { ...ApIdSchema, nullable: false },
        instructions: { type: 'text', nullable: true },
        memories: { type: 'jsonb', default: '[]' },
    },
    indices: [{ name: 'idx_syd_memory_owner', columns: ['platformId', 'userId'], unique: true }],
    relations: {
        platform: { type: 'many-to-one', target: 'platform', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'platformId', foreignKeyConstraintName: 'fk_syd_memory_platform' } },
        user: { type: 'many-to-one', target: 'user', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'userId', foreignKeyConstraintName: 'fk_syd_memory_user' } },
    },
})

export type SydUserMemoryWithRelations = UserMemory & { platform: Platform, user: User }
