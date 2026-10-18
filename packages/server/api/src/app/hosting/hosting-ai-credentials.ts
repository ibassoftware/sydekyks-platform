import { AIProviderModelType, AIProviderName } from '@activepieces/core-utils'
import { EntityManager } from 'typeorm'
import { aiKeyScope } from '../ai/ai-key-scope'
import { AIProviderEntity, AIProviderSchema } from '../ai/ai-provider-entity'
import { databaseConnection } from '../database/database-connection'
import { encryptUtils } from '../helper/encryption'
import { HOSTED_DEEPSEEK_MODEL, HostedAiInput, HostedKeyAuth } from './hosting-ai-policy'
import { managedCredential } from './hosting-managed-settings'
import { hostingFail } from './hosting-transactions'

export { HostedKeyAuth } from './hosting-ai-policy'

export async function hostedAiCredential({ manager, platformId, projectId, payer, model }: { manager: EntityManager, platformId: string, projectId: string, payer: HostedAiInput['payer'], model: string }): Promise<{ apiKey: string, fingerprint: string, model?: string }> {
    if (payer.type === 'managed') {
        return managedCredential(manager, platformId)
    }
    const row = await manager.getRepository(AIProviderEntity).findOneBy({ id: payer.configId, platformId })
    if (!row || row.provider !== AIProviderName.DEEPSEEK || row.status !== 'active' || !aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId } }) || !aiKeyScope.keyOffersModel({ key: row, modelId: model }) || Object.keys(row.config).length) hostingFail('HOSTING_BYOK_SCOPE_DENIED')
    const auth = HostedKeyAuth.safeParse(await encryptUtils.decryptObject<unknown>(row.auth))
    if (!auth.success) hostingFail('HOSTING_BYOK_SCOPE_DENIED')
    return { apiKey: auth.data.apiKey, fingerprint: await encryptUtils.hmacString(JSON.stringify([row.id, row.provider, row.auth, row.config, row.status, row.statusVersion, row.projectScope, [...row.projectIds].sort(), row.modelScope, [...row.modelIds].sort()])) }
}

export function hostedKeyResponse(row: AIProviderSchema) {
    return { id: row.id, provider: row.provider, displayName: row.displayName, status: row.status, modelScope: row.modelScope, modelIds: row.modelIds, projectScope: row.projectScope, projectIds: row.projectIds, enabledForChat: false, credentialValidation: 'not_probed' }
}

export async function hostedKeyModels({ platformId, configId }: { platformId: string, configId?: string }) {
    if (configId && !await databaseConnection().getRepository(AIProviderEntity).existsBy({ id: configId, platformId, provider: AIProviderName.DEEPSEEK })) hostingFail('HOSTING_BYOK_SCOPE_DENIED')
    return [{ id: HOSTED_DEEPSEEK_MODEL, name: HOSTED_DEEPSEEK_MODEL, type: AIProviderModelType.TEXT }]
}
