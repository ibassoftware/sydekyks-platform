import { isNil } from '@activepieces/core-utils'
import { ApEnvironment } from '@activepieces/shared'
import {
    DataSource,
    EntitySchema,
} from 'typeorm'
import { AIProviderEntity } from '../ai/ai-provider-entity'
import { AiToolConfigEntity } from '../ai/ai-tool-config-entity'
import { PlatformModelTierEntity } from '../ai/platform-model-tier-entity'
import { PlatformAnalyticsReportEntity } from '../analytics/platform-analytics-report.entity'
import { AppConnectionEntity } from '../app-connection/app-connection.entity'
import { OtpEntity } from '../authentication/otp/otp-entity'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { EventDestinationEntity } from '../event-destinations/event-destinations.entity'
import { FileEntity } from '../file/file.entity'
import { FlagEntity } from '../flags/flag.entity'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { FolderEntity } from '../flows/folder/folder.entity'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { HOSTING_ACCESS_ENTITIES } from '../hosting/hosting-access-entities'
import { HOSTING_AI_ALLOWANCE_ENTITIES } from '../hosting/hosting-ai-allowance-entities'
import { HostedAiFileEntity } from '../hosting/hosting-ai-file-entity'
import { HostingAssessmentEntity } from '../hosting/hosting-assessment-entity'
import { HOSTING_CHARGE_RESOLUTION_ENTITIES } from '../hosting/hosting-charge-resolution-entities'
import { HOSTING_CREDIT_ALLOWANCE_ENTITIES } from '../hosting/hosting-credit-allowance-entities'
import { HostingDispatchEntity } from '../hosting/hosting-dispatch-entity'
import { HOSTING_ENTITIES } from '../hosting/hosting-entities'
import { HOSTING_MANUAL_ACCOUNT_ENTITIES } from '../hosting/hosting-manual-accounts-entities'
import { HostingModelCallEntity } from '../hosting/hosting-model-call-entity'
import { HOSTING_PARTNER_ADMIN_ENTITIES } from '../hosting/hosting-partner-admin-entities'
import { HOSTING_PARTNER_BILLING_ENTITIES } from '../hosting/hosting-partner-billing-entities'
import { HOSTING_PARTNER_SETUP_ENTITIES } from '../hosting/hosting-partner-setup-entities'
import { HOSTING_PRICING_ENTITIES } from '../hosting/hosting-pricing-entities'
import { HOSTING_RECOVERY_ENTITIES } from '../hosting/hosting-recovery-entities'
import { HostingStorageLockEntity } from '../hosting/hosting-storage'
import { HOSTING_STRIPE_ENTITIES } from '../hosting/hosting-stripe-entities'
import { HOSTING_SUBSCRIPTION_ENTITIES } from '../hosting/hosting-subscription-entities'
import { HOSTING_TENANT_MEMBERS_ENTITIES } from '../hosting/hosting-tenant-members-entities'
import { HOSTING_TRAINER_ENTITIES } from '../hosting/hosting-trainer-entities'
import { HostingTrainingEntity } from '../hosting/hosting-training-entity'
import { KnowledgeBaseChunkEntity } from '../knowledge-base/knowledge-base-chunk.entity'
import { KnowledgeBaseFileEntity } from '../knowledge-base/knowledge-base-file.entity'
import { LMS_ENTITIES } from '../lms/lms-entities'
import { McpActivityEntity } from '../mcp/activity/mcp-activity-entity'
import { McpServerEntity } from '../mcp/mcp-entity'
import { McpOAuthClientEntity } from '../mcp/oauth/client/mcp-oauth-client.entity'
import { McpOAuthAuthorizationCodeEntity } from '../mcp/oauth/code/mcp-oauth-code.entity'
import { McpOAuthTokenEntity } from '../mcp/oauth/token/mcp-oauth-token.entity'
import { PieceMetadataEntity } from '../pieces/metadata/piece-metadata-entity'
import { PieceTranslationEntity } from '../pieces/metadata/piece-translation-entity'
import { PlatformConfigurationEntity } from '../platform/platform-configuration.entity'
import { PlatformEntity } from '../platform/platform.entity'
import { ProjectEntity } from '../project/project-entity'
import { StoreEntryEntity } from '../store-entry/store-entry-entity'
import { SydAgentConversationEntity } from '../syd/copilot/models/agent-conversation.entity'
import { SydChatManagedAgentEntity } from '../syd/copilot/models/chat-managed-agent.entity'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { SydPersonalizationEntity } from '../syd/copilot/models/personalization.entity'
import { SydUserMemoryEntity } from '../syd/copilot/models/user-memory.entity'
import { FieldEntity } from '../tables/field/field.entity'
import { CellEntity } from '../tables/record/cell.entity'
import { RecordEntity } from '../tables/record/record.entity'
import { TableWebhookEntity } from '../tables/table/table-webhook.entity'
import { TableEntity } from '../tables/table/table.entity'
import { TemplateEntity } from '../template/template.entity'
import { CATALOGUE_TODO_ENTITIES } from '../todos/todo-entities'
import { ToolSearchIndexEntity } from '../tool-search/tool-search-index.entity'
import { AppEventRoutingEntity } from '../trigger/app-event-routing/app-event-routing.entity'
import { TriggerEventEntity } from '../trigger/trigger-events/trigger-event.entity'
import { TriggerSourceEntity } from '../trigger/trigger-source/trigger-source-entity'
import { UserEntity } from '../user/user-entity'
import { UserInvitationEntity } from '../user-invitations/user-invitation.entity'
import { VariableEntity } from '../variable/variable.entity'
import { WaitpointEntity } from '../waitpoints/waitpoint-entity'
import { WaitpointSignalEntity } from '../waitpoints/waitpoint-signal-entity'
import { DatabaseType } from './database-type'
import { createPGliteDataSource } from './pglite-connection'
import { createPostgresDataSource, createPostgresMigrationDataSource } from './postgres-connection'

const databaseType = system.get(AppSystemProp.DB_TYPE)

function getEntities(): EntitySchema<unknown>[] {
    return [
        ...CATALOGUE_TODO_ENTITIES,
        HostedAiFileEntity,
        ...LMS_ENTITIES,
        ...HOSTING_ENTITIES,
        ...HOSTING_MANUAL_ACCOUNT_ENTITIES,
        ...HOSTING_TRAINER_ENTITIES,
        ...HOSTING_SUBSCRIPTION_ENTITIES,
        ...HOSTING_RECOVERY_ENTITIES,
        HostingAssessmentEntity,
        HostingStorageLockEntity,
        ...HOSTING_ACCESS_ENTITIES,
        ...HOSTING_AI_ALLOWANCE_ENTITIES,
        ...HOSTING_CREDIT_ALLOWANCE_ENTITIES,
        ...HOSTING_CHARGE_RESOLUTION_ENTITIES,
        ...HOSTING_PARTNER_ADMIN_ENTITIES,
        ...HOSTING_PARTNER_BILLING_ENTITIES,
        ...HOSTING_PARTNER_SETUP_ENTITIES,
        ...HOSTING_TENANT_MEMBERS_ENTITIES,
        ...HOSTING_STRIPE_ENTITIES,
        ...HOSTING_PRICING_ENTITIES,
        HostingDispatchEntity,
        HostingModelCallEntity,
        HostingTrainingEntity,
        TriggerEventEntity,
        AppEventRoutingEntity,
        FileEntity,
        FlagEntity,
        FlowEntity,
        FlowVersionEntity,
        FlowRunEntity,
        ProjectEntity,
        StoreEntryEntity,
        UserEntity,
        AppConnectionEntity,
        VariableEntity,
        FolderEntity,
        PieceMetadataEntity,
        PieceTranslationEntity,
        PlatformEntity,
        PlatformConfigurationEntity,
        UserInvitationEntity,
        AIProviderEntity,
        AiToolConfigEntity,
        PlatformModelTierEntity,
        TableEntity,
        FieldEntity,
        RecordEntity,
        CellEntity,
        TableWebhookEntity,
        UserIdentityEntity,
        McpActivityEntity,
        McpServerEntity,
        McpOAuthClientEntity,
        McpOAuthAuthorizationCodeEntity,
        McpOAuthTokenEntity,
        KnowledgeBaseFileEntity,
        KnowledgeBaseChunkEntity,
        ToolSearchIndexEntity,
        SydChatManagedAgentEntity,
        SydAgentConversationEntity,
        SydConversationEntity,
        SydPersonalizationEntity,
        SydUserMemoryEntity,
        TriggerSourceEntity,
        WaitpointEntity,
        WaitpointSignalEntity,
        // Enterprise
        OtpEntity,
        TemplateEntity,
        PlatformAnalyticsReportEntity,
        // CLOUD
        EventDestinationEntity,

    ]
}

export const commonProperties = {
    subscribers: [],
    entities: getEntities(),
}

const DB_GLOBAL_KEY = '__AP_DB_CONNECTION__'

function getPersistedConnection(): DataSource | null {
    return ((globalThis as Record<string, unknown>)[DB_GLOBAL_KEY] as DataSource) ?? null
}

function setPersistedConnection(ds: DataSource | null): void {
    (globalThis as Record<string, unknown>)[DB_GLOBAL_KEY] = ds
}

const createDataSource = (): DataSource => {
    switch (databaseType) {
        case DatabaseType.PGLITE:
            if (system.get(AppSystemProp.ENVIRONMENT) !== ApEnvironment.TESTING) throw new Error('This first Sydekyks release supports PostgreSQL installations only')
            return createPGliteDataSource()
        case DatabaseType.POSTGRES:
        default:
            return createPostgresDataSource()
    }
}

export const databaseConnection = (): DataSource => {
    const existing = getPersistedConnection()
    if (!isNil(existing)) {
        return existing
    }
    const ds = createDataSource()
    setPersistedConnection(ds)
    return ds
}

export const migrationDatabaseConnection = async (): Promise<DataSource> => {
    const persisted = getPersistedMigrationConnection()
    if (!isNil(persisted)) {
        return persisted
    }
    if (databaseType !== DatabaseType.POSTGRES) {
        return databaseConnection()
    }
    const dedicated = createPostgresMigrationDataSource()
    if (isNil(dedicated)) {
        return databaseConnection()
    }
    await dedicated.initialize()
    setPersistedMigrationConnection(dedicated)
    return dedicated
}

export function resetDatabaseConnection(): void {
    setPersistedConnection(null)
    setPersistedMigrationConnection(null)
}

const MIGRATION_DB_GLOBAL_KEY = '__AP_DB_MIGRATION_CONNECTION__'
function getPersistedMigrationConnection(): DataSource | null {
    return ((globalThis as Record<string, unknown>)[MIGRATION_DB_GLOBAL_KEY] as DataSource) ?? null
}
function setPersistedMigrationConnection(ds: DataSource | null): void {
    (globalThis as Record<string, unknown>)[MIGRATION_DB_GLOBAL_KEY] = ds
}
