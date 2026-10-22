import { FlowActionType, flowStructureUtil, WorkerJobType } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { HOSTED_LEGACY_MICRO_USD_PER_CREDIT, hostedAiCredits, hostedUsesCreditAccounting } from './hosting-credit-policy'
import { HostingDispatch } from './hosting-dispatch-entity'
import { HostingReservationEntity } from './hosting-entities'
import { HostingModelCallEntity } from './hosting-model-call-entity'
import { NativeToolInput } from './hosting-native-provider'
import { hostingFail } from './hosting-transactions'

export const HOSTED_NATIVE_CREDIT_LIMIT = 100n
export const HOSTED_NATIVE_MAX_OUTPUT = 2048

export async function nativeWebSearchEnabled(manager: EntityManager, segment: HostingDispatch): Promise<boolean> {
    const data = segment.payload
    if (data?.jobType === WorkerJobType.EXECUTE_AGENT_RUN) return 'nativeWebSearch' in data && data.nativeWebSearch === true
    if (data?.jobType === WorkerJobType.EXECUTE_ACTION) return nativeStep(data.step)
    if (data?.jobType === WorkerJobType.EXECUTE_FLOW) {
        const version = await manager.getRepository(FlowVersionEntity).findOneBy({ id: data.flowVersionId, flowId: data.flowId })
        return !!version && flowStructureUtil.getAllSteps(version.trigger).some(step => (!data.stepNameToTest || step.name === data.stepNameToTest) && nativeStep(step))
    }
    return false
}

function nativeStep(step: unknown): boolean {
    if (!step || typeof step !== 'object' || !('type' in step) || step.type !== FlowActionType.PIECE || !('settings' in step)) return false
    const settings = step.settings as { pieceName?: string, input?: { webSearch?: boolean } }
    return settings.pieceName === '@activepieces/piece-ai' && settings.input?.webSearch === true
}

export async function assertNativeRootBudget({ manager, platformId, rootId, maxCostMicroUsd, native }: { manager: EntityManager, platformId: string, rootId: string, maxCostMicroUsd: bigint, native: boolean }): Promise<void> {
    // Account lock must already serialize every call admission. Count all usage in
    // the root once it opts into a native feature, not just the three-Credit tools.
    if (!native && !await manager.getRepository(HostingModelCallEntity).existsBy({ platformId, rootReservationId: rootId, nativeFeature: true })) return
    const root = await manager.getRepository(HostingReservationEntity).findOneByOrFail({ id: rootId, platformId })
    const children = await manager.getRepository(HostingReservationEntity).findBy({ platformId, rootReservationId: rootId })
    const exposed = children.reduce((sum, item) => {
        if (['released', 'cancelled'].includes(item.state)) return sum
        const quantity = item.state === 'settled' ? item.actualAmount ?? item.amount : item.amount
        return sum + (hostedUsesCreditAccounting(item.accountingVersion) ? quantity : hostedAiCredits(quantity, item.microUsdPerCredit ?? HOSTED_LEGACY_MICRO_USD_PER_CREDIT))
    }, root.amount)
    if (exposed + hostedAiCredits(maxCostMicroUsd) > HOSTED_NATIVE_CREDIT_LIMIT) hostingFail('HOSTING_NATIVE_CREDIT_LIMIT')
}

export async function assertNativeWebSearchAllowed(manager: EntityManager, segment: HostingDispatch, input: Pick<NativeToolInput, 'stepName' | 'payer'>): Promise<void> {
    const data = segment.payload
    if (data?.jobType === WorkerJobType.EXECUTE_AGENT_RUN) {
        if (input.stepName || !await nativeWebSearchEnabled(manager, segment)) hostingFail('HOSTING_NATIVE_FEATURE_DENIED')
        return
    }
    const step = data?.jobType === WorkerJobType.EXECUTE_ACTION ? data.step : data?.jobType === WorkerJobType.EXECUTE_FLOW && input.stepName
        ? flowStructureUtil.getAllSteps((await manager.getRepository(FlowVersionEntity).findOneByOrFail({ id: data.flowVersionId, flowId: data.flowId })).trigger).find(item => item.name === input.stepName && (!data.stepNameToTest || item.name === data.stepNameToTest)) : undefined
    if (!step || input.stepName && input.stepName !== step.name || !nativeStep(step) || step.type !== FlowActionType.PIECE) hostingFail('HOSTING_NATIVE_FEATURE_DENIED')
    const selected = step.settings.input.provider
    const provider = (typeof selected === 'string' ? { provider: selected } : selected) as { provider?: string, configId?: string } | undefined
    if (input.payer.type === 'byok' ? provider?.provider !== 'deepseek' || provider?.configId !== input.payer.configId : provider?.provider !== 'activepieces' || provider?.configId !== undefined) hostingFail('HOSTING_AI_PAYER_CONFLICT')
}

export async function nativeFeaturesEnabled(manager: EntityManager, segment: HostingDispatch): Promise<boolean> {
    if (await nativeWebSearchEnabled(manager, segment)) return true
    const data = segment.payload
    if (data?.jobType === WorkerJobType.EXECUTE_AGENT_RUN) return 'nativeFileIds' in data && Array.isArray(data.nativeFileIds) && data.nativeFileIds.length > 0
    const steps = data?.jobType === WorkerJobType.EXECUTE_ACTION ? [data.step] : data?.jobType === WorkerJobType.EXECUTE_FLOW ? flowStructureUtil.getAllSteps((await manager.getRepository(FlowVersionEntity).findOneByOrFail({ id: data.flowVersionId, flowId: data.flowId })).trigger).filter(step => !data.stepNameToTest || step.name === data.stepNameToTest) : []
    return steps.some(step => step.type === FlowActionType.PIECE && step.settings.pieceName === '@activepieces/piece-ai' && (typeof step.settings.input.fileIds === 'string' && step.settings.input.fileIds.length > 0 || Array.isArray(step.settings.input.fileIds) && step.settings.input.fileIds.length > 0))
}
