import { ChatPersonalization, ChatPersonalizationStatus, Platform, User } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../../database/database-common'

export const SydPersonalizationEntity = new EntitySchema<SydPersonalizationWithRelations>({
    name: 'syd_personalization',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: { ...ApIdSchema, nullable: false },
        userId: { ...ApIdSchema, nullable: true },
        domain: { type: String, nullable: true },
        companyText: { type: String, nullable: true },
        role: { type: String, nullable: true },
        status: { type: String, default: ChatPersonalizationStatus.PENDING },
        researchToken: { ...ApIdSchema, nullable: true },
        profile: { type: 'jsonb', nullable: true },
        useCases: { type: 'jsonb', nullable: true },
    },
    indices: [
        { name: 'idx_syd_personalization_platform', columns: ['platformId'] },
        { name: 'idx_syd_personalization_user', columns: ['platformId', 'userId'], unique: true, where: '"userId" IS NOT NULL' },
        { name: 'idx_syd_personalization_company', columns: ['platformId'], unique: true, where: '"userId" IS NULL' },
    ],
    relations: {
        platform: { type: 'many-to-one', target: 'platform', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'platformId', foreignKeyConstraintName: 'fk_syd_personalization_platform' } },
        user: { type: 'many-to-one', target: 'user', cascade: true, onDelete: 'CASCADE', joinColumn: { name: 'userId', foreignKeyConstraintName: 'fk_syd_personalization_user' } },
    },
})

export type SydPersonalizationWithRelations = ChatPersonalization & { platform: Platform, user: User | null }
