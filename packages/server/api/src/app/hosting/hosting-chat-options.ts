import { AIProviderName } from '@activepieces/core-utils'
import { EntityManager } from 'typeorm'
import { aiKeyScope } from '../ai/ai-key-scope'
import { AIProviderEntity } from '../ai/ai-provider-entity'
import { SydConversationEntity } from '../syd/copilot/models/conversation.entity'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL } from './hosting-ai-policy'
import { readManagedConfiguration } from './hosting-managed-settings'
import { readApprovedPricing } from './hosting-pricing'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'
import { readHostedCredits } from './hosting-usage'

export async function hostedChatOptions({ manager, actor, userId, projectId: requestedProjectId, conversationId }: { manager: EntityManager, actor: HostingActor, userId: string, projectId: string, conversationId?: string }) {
    const conversation = conversationId ? await manager.getRepository(SydConversationEntity).findOneBy({ id: conversationId, platformId: actor.platformId, userId }) : null
    if (conversationId && !conversation) hostingFail('HOSTING_ACCESS_DENIED')
    const projectId = conversation?.projectId ?? requestedProjectId
    await tx.member({ manager, actor, projectId, write: true })
    const rows = await manager.getRepository(AIProviderEntity).find({ where: { platformId: actor.platformId, provider: AIProviderName.DEEPSEEK, status: 'active' }, order: { displayName: 'ASC', id: 'ASC' } })
    let managedAvailable = false
    try {
        const managed = await readManagedConfiguration(manager, actor.platformId)
        if (!managed.disabled && managed.model && managed.secretId) {
            await readApprovedPricing(manager, await tx.now(manager), managed.model)
            managedAvailable = true
        }
    }
    catch {
        // Configuration availability only; never probe a provider or disclose its credentials.
    }
    const account = await tx.account({ manager, platformId: actor.platformId })
    const credits = await readHostedCredits(manager, account, await tx.now(manager))
    managedAvailable = managedAvailable && BigInt(credits.execution.available) > 0n && BigInt(credits.ai.available) > 0n
    return { credits: { execution: credits.execution }, platformId: actor.platformId, userId, requestedProjectId, projectId, conversationId: conversationId ?? null, model: { id: HOSTED_MANAGED_MODEL, label: 'Sydekyks' }, managedAvailable,
        keys: rows.filter(row => !Object.keys(row.config).length && aiKeyScope.rowAllowsScope({ row, scope: { type: 'project', projectId } }) && aiKeyScope.keyOffersModel({ key: row, modelId: HOSTED_DEEPSEEK_MODEL })).map(row => ({ id: row.id, name: row.displayName })) }
}
