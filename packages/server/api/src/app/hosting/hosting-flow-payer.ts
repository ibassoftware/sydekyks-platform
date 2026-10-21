import { AIProviderName } from '@activepieces/core-utils'
import { FlowAction, FlowActionType, flowStructureUtil, FlowTrigger, FlowVersion } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { hostedAiCredential } from './hosting-ai-credentials'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_MANAGED_MODEL } from './hosting-ai-policy'
import { hostingFail } from './hosting-transactions'

// Reserve managed execution credits whenever any potential AI branch is managed.
// Each actual model call still validates and charges its own exact payer.
export function hostedFlowPayer(version: Pick<FlowVersion, 'trigger'>, stepNameToTest?: string): 'managed' | 'byok' {
    if (!version.trigger) return 'managed'
    const allSteps = flowStructureUtil.getAllSteps(version.trigger)
    const selectedStep = stepNameToTest ? allSteps.find(step => step.name === stepNameToTest) : undefined
    if (stepNameToTest && !selectedStep) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
    // Engine single-step tests execute exactly this action, not its successors or branches.
    return hostedStepsPayer(selectedStep ? [selectedStep] : allSteps)
}

export function hostedActionPayer(step: FlowAction): 'managed' | 'byok' {
    return hostedStepsPayer([step])
}

function hostedStepsPayer(steps: (FlowAction | FlowTrigger)[]): 'managed' | 'byok' {
    let selected: 'managed' | 'byok' | null = null
    for (const step of steps) {
        if (step.type === FlowActionType.AI_ROUTER || (step.type === FlowActionType.PIECE && step.settings.pieceName === '@activepieces/piece-ai' && step.settings.actionName === 'run_agent')) {
            selected = 'managed'
            continue
        }
        if (step.type !== FlowActionType.PIECE || step.settings.pieceName !== '@activepieces/piece-ai') continue
        if (!step.settings.actionName || !['askAi', 'summarizeText', 'classifyText', 'extractStructuredData'].includes(step.settings.actionName)) hostingFail('HOSTING_FLOW_AI_PATH_UNSUPPORTED')
        const input = step.settings.input
        if (step.settings.actionName === 'extractStructuredData' && input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 0)) hostingFail('HOSTING_AI_EXTRACTION_TEXT_ONLY')
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
        if (selected !== 'managed') selected = payer
    }
    return selected ?? 'managed'
}
export async function currentHostedFlowPayer({ manager, platformId, flowId, flowVersionId, projectId, stepNameToTest }: { manager: EntityManager, platformId: string, flowId: string, flowVersionId: string, projectId: string, stepNameToTest?: string }): Promise<'managed' | 'byok'> {
    if (!await manager.getRepository(FlowEntity).existsBy({ id: flowId, projectId })) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
    const version = await manager.getRepository(FlowVersionEntity).findOne({ where: { id: flowVersionId, flowId }, lock: { mode: 'pessimistic_read' } })
    if (!version) hostingFail('HOSTING_FLOW_SCOPE_MISMATCH')
    const payer = hostedFlowPayer(version, stepNameToTest)
    const steps = flowStructureUtil.getAllSteps(version.trigger)
    await validateHostedStepKeys({ manager, platformId, projectId, steps: stepNameToTest ? steps.filter(value => value.name === stepNameToTest) : steps })
    return payer
}

export async function currentHostedActionPayer({ manager, platformId, projectId, step }: { manager: EntityManager, platformId: string, projectId: string, step: FlowAction }): Promise<'managed' | 'byok'> {
    const payer = hostedActionPayer(step)
    await validateHostedStepKeys({ manager, platformId, projectId, steps: [step] })
    return payer
}

async function validateHostedStepKeys({ manager, platformId, projectId, steps }: { manager: EntityManager, platformId: string, projectId: string, steps: (FlowAction | FlowTrigger)[] }): Promise<void> {
    for (const step of steps) {
        if (step.type !== FlowActionType.PIECE || step.settings.pieceName !== '@activepieces/piece-ai') continue
        const provider = step.settings.input.provider
        if (!provider || typeof provider !== 'object' || !('provider' in provider) || provider.provider !== AIProviderName.DEEPSEEK) continue
        if (!('configId' in provider) || typeof provider.configId !== 'string') hostingFail('HOSTING_EXACT_BYOK_KEY_REQUIRED')
        await hostedAiCredential({ manager, platformId, projectId, payer: { type: 'byok', configId: provider.configId }, model: HOSTED_DEEPSEEK_MODEL })
    }
}
