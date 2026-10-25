import { apId } from '@activepieces/core-utils'
import { AgentRunSource, FlowActionType, PlatformRole, StepLocationRelativeToParent } from '@activepieces/shared'
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeHostedBuilderTool, hostedBuilderConfiguration } from '../../../../src/app/hosting/hosting-builder-tools'
import { mcpServerService } from '../../../../src/app/mcp/mcp-service'
import { apAddStepTool } from '../../../../src/app/mcp/tools/ap-add-step'
import { apCreateFlowTool } from '../../../../src/app/mcp/tools/ap-create-flow'
import { apReadStepSettingsTool } from '../../../../src/app/mcp/tools/ap-read-step-settings'
import { sydApprovalGate } from '../../../../src/app/syd/copilot/approval-gate'
import { sydRunOperations } from '../../../../src/app/syd/copilot/rpc/run-operations'
import { createTestContext, createWorkspaceUserContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
beforeAll(async () => {
    app = await setupTestEnvironment()
})
afterAll(async () => {
    await teardownTestEnvironment()
})

const conditions = [[{ firstValue: '{{trigger[\'output\'].category}}', operator: 'TEXT_EXACTLY_MATCHES', secondValue: 'qualified' }]]
const branchTools = ['ap_add_branch', 'ap_update_branch'] as const

async function routerDraft() {
    const ctx = await createTestContext(app)
    const mcp = { ...await mcpServerService(app.log).getByProjectId(ctx.project.id), projectId: ctx.project.id }
    const created = await apCreateFlowTool({ mcp, userId: ctx.user.id }, app.log).execute({ flowName: 'Hosted router regression' })
    const flowId = created.structuredContent!.flowId as string
    await apAddStepTool({ mcp, userId: ctx.user.id }, app.log).execute({ flowId, parentStepName: 'trigger', stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER, stepType: FlowActionType.ROUTER, displayName: 'Qualify' })
    const scope = { projectId: ctx.project.id, platformId: ctx.platform.id, userId: ctx.user.id, log: app.log }
    const run = { source: AgentRunSource.CHAT, conversationId: apId(), runId: apId() }
    const invoke = (toolName: string, toolInput: Record<string, unknown>) => executeHostedBuilderTool({ ...scope, ...run, toolName, toolInput })
    const read = () => invoke('ap_read_step_settings', { flowId, stepName: 'step_1' })
    const branchInput = (toolName: typeof branchTools[number]) => toolName === 'ap_update_branch'
        ? { flowId, routerStepName: 'step_1', branchIndex: 0, conditions }
        : { flowId, routerStepName: 'step_1', branchName: 'Another route', conditions }
    const gate = async (toolName: string, toolInput: Record<string, unknown>, decision?: boolean) => {
        const gateId = apId()
        await sydApprovalGate.storePendingGate({ conversationId: run.conversationId, gate: { gateId, runId: run.runId, toolName, displayName: 'Reviewed branch change', toolInput } })
        if (decision !== undefined) await sydApprovalGate.resolveGate({ gateId, approved: decision })
        return gateId
    }
    return { ctx, mcp, flowId, scope, run, invoke, read, branchInput, gate }
}

describe('hosted router branch editors with real persistence and approvals', () => {
    it.each(branchTools)('%s rejects missing, pending, and declined approval after a read without changing the draft', async (toolName) => {
        const draft = await routerDraft()
        const before = await draft.read()
        const input = draft.branchInput(toolName)
        await expect(draft.invoke(toolName, input)).rejects.toThrow('HOSTING_TOOL_APPROVAL_REQUIRED')
        const pending = await draft.gate(toolName, input)
        await expect(draft.invoke(toolName, { ...input, approvedGateId: pending })).rejects.toThrow('HOSTING_TOOL_APPROVAL_REQUIRED')
        const declined = await draft.gate(toolName, input, false)
        await expect(draft.invoke(toolName, { ...input, approvedGateId: declined })).rejects.toThrow('HOSTING_TOOL_APPROVAL_REQUIRED')
        expect((await draft.read()).structuredContent).toEqual(before.structuredContent)
    })

    it.each(branchTools)('%s persists only the exact approved input and refuses approval replay', async (toolName) => {
        const draft = await routerDraft()
        const names = (await hostedBuilderConfiguration(draft.scope)).map(tool => tool.name)
        expect(names).toEqual(expect.arrayContaining([...branchTools]))
        await draft.read()
        const input = draft.branchInput(toolName)
        const gateId = await draft.gate(toolName, input, true)
        await expect(draft.invoke(toolName, { ...input, conditions: [[{ firstValue: 'changed', operator: 'EXISTS' }]], approvedGateId: gateId })).rejects.toThrow('HOSTING_TOOL_APPROVAL_REQUIRED')
        const otherRunId = apId()
        await sydRunOperations.markTurnAsHavingRead({ conversationId: draft.run.conversationId, runId: otherRunId })
        await expect(executeHostedBuilderTool({ ...draft.scope, ...draft.run, runId: otherRunId, toolName, toolInput: { ...input, approvedGateId: gateId } })).rejects.toThrow('HOSTING_TOOL_APPROVAL_REQUIRED')
        const result = await draft.invoke(toolName, { ...input, approvedGateId: gateId })
        expect(result.content[0].text).toContain('✅')
        const saved = await draft.read()
        const branchIndex = toolName === 'ap_update_branch' ? 0 : 1
        const settings = saved.structuredContent!.settings as { branches: { conditions?: unknown }[] }
        expect(settings.branches[branchIndex].conditions).toEqual(conditions)
        await expect(draft.invoke(toolName, { ...input, approvedGateId: gateId })).rejects.toThrow('HOSTING_TOOL_APPROVAL_REQUIRED')
    })

    it.each(branchTools)('%s cannot modify a flow from another tenant or substitute the admitted project', async (toolName) => {
        const owner = await routerDraft()
        const other = await routerDraft()
        const before = await apReadStepSettingsTool(other.mcp, app.log).execute({ flowId: other.flowId, stepName: 'step_1' })
        const foreignInput = { ...owner.branchInput(toolName), flowId: other.flowId }
        const result = await owner.invoke(toolName, foreignInput)
        expect(result.content[0].text).toContain('Flow not found')
        await expect(owner.invoke(toolName, { ...foreignInput, projectId: other.ctx.project.id })).rejects.toThrow('HOSTING_AI_SEGMENT_DENIED')
        expect((await apReadStepSettingsTool(other.mcp, app.log).execute({ flowId: other.flowId, stepName: 'step_1' })).structuredContent).toEqual(before.structuredContent)
    })

    it.each(branchTools)('%s is neither advertised nor executable without WRITE_FLOW permission', async (toolName) => {
        const draft = await routerDraft()
        const operator = await createWorkspaceUserContext({ app, parentCtx: draft.ctx, platformRole: PlatformRole.OPERATOR })
        const scope = { ...draft.scope, userId: operator.user.id }
        expect((await hostedBuilderConfiguration(scope)).map(tool => tool.name)).not.toContain(toolName)
        await expect(executeHostedBuilderTool({ ...scope, ...draft.run, toolName, toolInput: draft.branchInput(toolName) })).rejects.toThrow('HOSTING_TOOL_ACCESS_DENIED')
    })

    it.each(branchTools)('%s respects the workspace disabled-tools list', async (toolName) => {
        const draft = await routerDraft()
        await mcpServerService(app.log).update({ projectId: draft.ctx.project.id, disabledTools: [toolName] })
        expect((await hostedBuilderConfiguration(draft.scope)).map(tool => tool.name)).not.toContain(toolName)
        await expect(draft.invoke(toolName, draft.branchInput(toolName))).rejects.toThrow('HOSTING_TOOL_ACCESS_DENIED')
    })
})
