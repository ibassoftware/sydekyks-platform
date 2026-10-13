import { Agent, AgentConversation, AgentConversationStatus, AgentRunSource, Platform, Project, User } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { SydConversationEntity } from './conversation.entity'

export const SydAgentConversationEntity = new EntitySchema<SydAgentConversationWithRelations>({
    name: 'agent_conversation',
    columns: SydConversationEntity.options.columns,
    indices: [
        { name: 'idx_agent_conversation_platform_user_created_id', columns: ['platformId', 'userId', 'created', 'id'] },
        { name: 'idx_agent_conversation_flow_step_created', columns: ['created', 'projectId'], where: `source = '${AgentRunSource.FLOW_STEP}'` },
        { name: 'idx_agent_conversation_agent_runs_created_id', columns: ['projectId', 'agentId', 'created', 'id'], where: `source = '${AgentRunSource.FLOW_STEP}' AND "agentId" IS NOT NULL` },
        { name: 'idx_agent_conversation_agent_user_created_id', columns: ['agentId', 'userId', 'created', 'id'], where: '"agentId" IS NOT NULL' },
        { name: 'idx_agent_conversation_streaming_updated', columns: ['updated'], where: `status = '${AgentConversationStatus.STREAMING}'` },
    ],
    relations: {
        platform: { type: 'many-to-one', target: 'platform', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'platformId', foreignKeyConstraintName: 'fk_agent_conversation_platform_id' } },
        project: { type: 'many-to-one', target: 'project', cascade: true, onDelete: 'SET NULL', joinColumn: { name: 'projectId', foreignKeyConstraintName: 'fk_agent_conversation_project_id' } },
        user: { type: 'many-to-one', target: 'user', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'userId', foreignKeyConstraintName: 'fk_agent_conversation_user_id' } },
        agent: { type: 'many-to-one', target: 'agent', onDelete: 'CASCADE', joinColumn: { name: 'agentId', foreignKeyConstraintName: 'fk_agent_conversation_agent_id' } },
    },
})

export type SydAgentConversationWithRelations = AgentConversation & { platform: Platform, project: Project | null, user: User, agent: Agent | null }
