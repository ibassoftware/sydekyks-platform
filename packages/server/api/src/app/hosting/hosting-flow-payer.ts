import { AIProviderName } from '@activepieces/core-utils'
import { FlowActionType, flowStructureUtil, FlowVersion } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { hostedAiCredential } from './hosting-ai-credentials'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL } from './hosting-ai-policy'
import { hostingFail } from './hosting-transactions'

// The pilot supports one payer per execution. Read the persisted version, never
// a worker-supplied provider or browser claim. Every potential AI branch counts.
export function hostedFlowPayer(version: Pick<FlowVersion, 'trigger'>, stepNameToTest?: string): 'managed' | 'byok' {
    let selected: 'managed' | 'byok' | null = null
    if (!version.trigger) return 'managed'
    const allSteps = flowStructureUtil.getAllSteps(version.trigger)
    const selectedStep = stepNameToTest ? allSteps.find(step => step.name === stepNameToTest) : undefined
    if (stepNameToTest && !selectedStep) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
    // Engine single-step tests execute exactly this action, not its successors or branches.
    for (const step of selectedStep ? [selectedStep] : allSteps) {
        if (step.type === FlowActionType.AI_ROUTER) hostingFail('HOSTING_FLOW_AI_PATH_UNSUPPORTED')
        if (step.type !== FlowActionType.PIECE || step.settings.pieceName !== '@activepieces/piece-ai') continue
        if (!step.settings.actionName || !['askAi', 'summarizeText', 'classifyText'].includes(step.settings.actionName)) hostingFail('HOSTING_FLOW_AI_PATH_UNSUPPORTED')
        const input = step.settings.input
        const value: unknown = input.provider
        const provider = typeof value === 'string' ? value : value && typeof value === 'object' && 'provider' in value ? value.provider : undefined
        const configId = value && typeof value === 'object' && 'configId' in value ? value.configId : undefined
        let payer: 'managed' | 'byok'
        if (provider === AIProviderName.DEEPSEEK) {
            if (typeof configId !== 'string' || !/^[a-zA-Z0-9]{21}$/.test(configId)) hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
            if (input.model !== HOSTED_DEEPSEEK_MODEL) hostingFail('HOSTING_AI_MODEL_DENIED')
            payer = 'byok'
        }
        else if (provider === AIProviderName.ACTIVEPIECES) {
            if (configId !== undefined || input.model !== HOSTED_MANAGED_MODEL) hostingFail('HOSTING_AI_PAYER_CONFLICT')
            payer = 'managed'
        }
        else hostingFail('HOSTING_FLOW_AI_PROVIDER_UNSUPPORTED')
        if (selected && selected !== payer) hostingFail('HOSTING_FLOW_MIXED_AI_PAYERS_UNSUPPORTED')
        selected = payer
    }
    return selected ?? 'managed'
}
export async function currentHostedFlowPayer({ manager, platformId, flowId, flowVersionId, projectId, stepNameToTest }: { manager: EntityManager, platformId: string, flowId: string, flowVersionId: string, projectId: string, stepNameToTest?: string }): Promise<'managed' | 'byok'> {
    if (!await manager.getRepository(FlowEntity).existsBy({ id: flowId, projectId })) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
    const version = await manager.getRepository(FlowVersionEntity).findOne({ where: { id: flowVersionId, flowId }, lock: { mode: 'pessimistic_read' } })
    if (!version) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
    const payer = hostedFlowPayer(version, stepNameToTest)
    if (payer === 'byok') {
        const steps = flowStructureUtil.getAllSteps(version.trigger)
        for (const step of stepNameToTest ? steps.filter(value => value.name === stepNameToTest) : steps) {
            if (step.type !== FlowActionType.PIECE || step.settings.pieceName !== '@activepieces/piece-ai') continue
            const provider = step.settings.input.provider
            // hostedFlowPayer has already rejected dynamic/missing config IDs.
            if (!provider || typeof provider !== 'object' || !('configId' in provider) || typeof provider.configId !== 'string') hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
            await hostedAiCredential({ manager, platformId, projectId, payer: { type: 'byok', configId: provider.configId }, model: HOSTED_DEEPSEEK_MODEL })
        }
    }
    return payer
}
