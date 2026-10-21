import { AgentConversationStatus, AgentRunSource, WorkerJobType, WorkerToApiContract } from '@activepieces/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ source: 'AGENT', status: 'STREAMING', projectId: 'project', cancelled: false, lookedUp: [] as string[], payload: {} as Record<string, unknown> }))
vi.mock('../../src/app/database/database-connection', () => ({ databaseConnection: () => ({}) }))
vi.mock('../../src/app/hosting/hosting-configuration', () => ({ hostingConfiguration: { getServiceMode: () => 'hosted' } }))
vi.mock('../../src/app/syd/copilot/approval-gate', () => ({ sydApprovalGate: { isCancelled: async () => state.cancelled } }))
vi.mock('../../src/app/hosting/hosting-transactions', () => ({
    hostingFail: (code: string) => {
        throw new Error(code) 
    },
    hostingTransactions: {
        run: async ({ fn }: { fn: (manager: unknown) => unknown }) => fn({ getRepository: (entity: { options: { name: string } }) => {
            const name = entity.options.name
            state.lookedUp.push(name)
            const row = name === 'hosting_dispatch' ? { id: 'dispatch', admissionId: 'admission', state: 'running', platformId: 'platform', projectId: 'project', identityId: 'identity', tokenVersion: 'token', connectionId: 'socket', terminalReceipt: null, leaseUntil: new Date('2030-01-01'), payload: state.payload } : { id: 'conversation', source: state.source, projectId: state.projectId, status: state.status }
            return { findOneBy: async () => row, findOneByOrFail: async () => row }
        } }),
        account: async () => ({}), member: async () => undefined, now: async () => new Date('2026-01-01'), assertActive: () => undefined,
    },
}))
import { hostedCopilotScope, protectHostedCopilotRpc } from '../../src/app/hosting/hosting-copilot'

beforeEach(() => {
    state.source = AgentRunSource.AGENT
    state.status = AgentConversationStatus.STREAMING
    state.projectId = 'project'
    state.cancelled = false
    state.lookedUp = []
    state.payload = { jobType: WorkerJobType.EXECUTE_AGENT_RUN, conversationId: 'conversation', runId: 'run', platformId: 'platform', projectId: 'project', userId: 'user', source: AgentRunSource.AGENT, userMessage: 'Task' }
})

describe('admitted saved Agent RPC scope', () => {
    it.each([AgentRunSource.AGENT, AgentRunSource.AGENT_BUILDER, AgentRunSource.FLOW_STEP])('loads the durable Agent conversation for %s rather than root-chat rows', async source => {
        state.source = source; state.payload.source = source
        await hostedCopilotScope({ admissionId: 'admission', connectionId: 'socket' })
        expect(state.lookedUp).toContain('agent_conversation')
        expect(state.lookedUp).not.toContain('syd_conversation')
    })
    it('accepts normalized managed tool metadata while deriving authority from the dispatch', async () => {
        const execute = vi.fn(async input => input)
        const rpc = protectHostedCopilotRpc({ executePieceTool: execute } as unknown as WorkerToApiContract, 'socket')
        await rpc.executePieceTool({ conversationId: 'conversation', runId: 'run', admissionId: 'admission', requestKey: 'tool-call', toolName: 'configured', instruction: 'Read it', provider: 'activepieces', providerConfigId: '', modelId: 'sydekyks', piece: {} } as never)
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ platformId: 'platform', projectId: 'project', userId: 'user', source: AgentRunSource.AGENT }))
    })
    it('rejects cross-tenant, stale-connection and substituted exact-key claims', async () => {
        await expect(hostedCopilotScope({ admissionId: 'admission', connectionId: 'other' })).rejects.toThrow('SEGMENT_DENIED')
        await expect(hostedCopilotScope({ admissionId: 'admission', input: { projectId: 'foreign' } })).rejects.toThrow('SEGMENT_DENIED')
        await expect(hostedCopilotScope({ admissionId: 'admission', input: { provider: 'deepseek', providerConfigId: 'other-key' } })).rejects.toThrow('SEGMENT_DENIED')
        state.projectId = 'foreign'
        await expect(hostedCopilotScope({ admissionId: 'admission' })).rejects.toThrow('SEGMENT_DENIED')
    })
    it('allows final callbacks after transcript save but refuses new spend after save or cancellation', async () => {
        state.status = AgentConversationStatus.IDLE
        await hostedCopilotScope({ admissionId: 'admission' })
        await expect(hostedCopilotScope({ admissionId: 'admission', spending: true })).rejects.toThrow('SEGMENT_DENIED')
        state.status = AgentConversationStatus.STREAMING; state.cancelled = true
        await expect(hostedCopilotScope({ admissionId: 'admission', spending: true })).rejects.toThrow('SEGMENT_DENIED')
    })
    it('keeps unmediated provider and personalization paths closed', async () => {
        const execute = vi.fn()
        const rpc = protectHostedCopilotRpc({ getPersonalizationConfig: execute } as unknown as WorkerToApiContract, 'socket')
        await expect(rpc.getPersonalizationConfig({ admissionId: 'admission' } as never)).rejects.toThrow('TOOL_NOT_METERED')
        expect(execute).not.toHaveBeenCalled()
    })
})
