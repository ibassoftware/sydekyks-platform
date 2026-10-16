import { AIProviderModelType, AIProviderName } from '@activepieces/core-utils'
import { EntityManager } from 'typeorm'
import { z } from 'zod'
import { aiKeyScope } from '../ai/ai-key-scope'
import { AIProviderEntity, AIProviderSchema } from '../ai/ai-provider-entity'
import { databaseConnection } from '../database/database-connection'
import { encryptUtils } from '../helper/encryption'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { HOSTED_DEEPSEEK_MODEL, HostedAiInput } from './hosting-ai-policy'
import { hostingFail } from './hosting-transactions'

export const HostedKeyAuth = z.strictObject({ apiKey: z.string().min(16).max(512).regex(/^\S+$/) })

export async function hostedAiCredential({ manager, platformId, projectId, payer, model }: { manager: EntityManager, platformId: string, projectId: string, payer: HostedAiInput['payer'], model: string }): Promise<{ apiKey: string, fingerprint: string }> {
    if (payer.type === 'managed') {
        const key = system.get(AppSystemProp.HOSTED_DEEPSEEK_API_KEY)
        const parsed = HostedKeyAuth.safeParse({ apiKey: key })
        if (!parsed.success) hostingFail('HOSTING_MANAGED_AI_UNAVAILABLE')
        return { apiKey: parsed.data.apiKey, fingerprint: await encryptUtils.hmacString(`deepseek:managed:${parsed.data.apiKey}`) }
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
