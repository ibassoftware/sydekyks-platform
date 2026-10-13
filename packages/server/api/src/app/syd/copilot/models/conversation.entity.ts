import { AgentConversation, AgentConversationStatus, AgentRunSource, Platform, Project, User } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../../database/database-common'

export const SydConversationEntity = new EntitySchema<SydConversationWithRelations>({
    name: 'syd_conversation',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: { ...ApIdSchema, nullable: false },
        userId: { ...ApIdSchema, nullable: false },
        projectId: { ...ApIdSchema, nullable: true },
        agentId: { ...ApIdSchema, nullable: true },
        flowRunId: { ...ApIdSchema, nullable: true },
        source: { type: String, default: AgentRunSource.CHAT },
        title: { type: String, nullable: true },
        modelName: { type: String, nullable: true },
        status: { type: String, default: AgentConversationStatus.IDLE },
        activeRunId: { type: String, nullable: true },
        aiCredits: { type: Number, nullable: true },
        messages: { type: 'jsonb', default: '[]' },
        uiMessages: { type: 'jsonb', nullable: true },
        summary: { type: 'text', nullable: true },
        summarizedUpToIndex: { type: Number, nullable: true },
    },
    checks: [{ name: 'chk_syd_conversation_chat', expression: 'source = \'CHAT\' AND "agentId" IS NULL AND "flowRunId" IS NULL' }],
    indices: [
        { name: 'idx_syd_conversation_owner_created', columns: ['platformId', 'userId', 'created', 'id'] },
        { name: 'idx_syd_conversation_streaming', columns: ['updated'], where: 'status = \'STREAMING\'' },
    ],
    relations: {
        platform: { type: 'many-to-one', target: 'platform', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'platformId', foreignKeyConstraintName: 'fk_syd_conversation_platform' } },
        user: { type: 'many-to-one', target: 'user', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'userId', foreignKeyConstraintName: 'fk_syd_conversation_user' } },
        project: { type: 'many-to-one', target: 'project', cascade: true, onDelete: 'SET NULL', joinColumn: { name: 'projectId', foreignKeyConstraintName: 'fk_syd_conversation_project' } },
    },
})

export type SydConversationWithRelations = AgentConversation & { platform: Platform, user: User, project: Project | null }
