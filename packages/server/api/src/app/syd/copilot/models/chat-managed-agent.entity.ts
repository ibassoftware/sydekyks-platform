import { Agent, Folder, Project, User } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../../database/database-common'

export const SydChatManagedAgentEntity = new EntitySchema<SydAgentWithRelations>({
    name: 'agent',
    columns: {
        ...BaseColumnSchemaPart,
        projectId: { ...ApIdSchema, nullable: false }, ownerId: { ...ApIdSchema, nullable: false }, folderId: { ...ApIdSchema, nullable: true },
        externalId: { type: String }, displayName: { type: String }, description: { type: String, nullable: true },
        icon: { type: String }, color: { type: String }, visibility: { type: String },
        sharedWithUserIds: { type: String, array: true, nullable: false, default: '{}' }, draft: { type: 'jsonb' }, published: { type: 'jsonb', nullable: true },
    },
    indices: [
        { name: 'idx_agent_project_created_id', columns: ['projectId', 'created', 'id'] },
        { name: 'idx_agent_project_external_id', columns: ['projectId', 'externalId'], unique: true },
        { name: 'idx_agent_folder_id', columns: ['folderId'] },
    ],
    relations: {
        project: { type: 'many-to-one', target: 'project', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'projectId', foreignKeyConstraintName: 'fk_agent_project_id' } },
        owner: { type: 'many-to-one', target: 'user', joinColumn: { name: 'ownerId', foreignKeyConstraintName: 'fk_agent_owner_id' } },
        folder: { type: 'many-to-one', target: 'folder', nullable: true, onDelete: 'SET NULL', joinColumn: { name: 'folderId', foreignKeyConstraintName: 'fk_agent_folder_id' } },
    },
})

export type SydAgentWithRelations = Agent & { project: Project, owner: User, folder?: Folder }
