import { apId } from '@activepieces/core-utils'
import { FlowActionType, McpServerType, ProjectScopedMcpServer, StepLocationRelativeToParent } from '@activepieces/shared'
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as flows from '../../../../src/app/flows/flow/flow.service'
import { apAddStepTool } from '../../../../src/app/mcp/tools/ap-add-step'
import { apCreateFlowTool } from '../../../../src/app/mcp/tools/ap-create-flow'
import { apReadStepSettingsTool } from '../../../../src/app/mcp/tools/ap-read-step-settings'
import { apUpdateBranchTool } from '../../../../src/app/mcp/tools/ap-update-branch'
import { apUpdateStepTool } from '../../../../src/app/mcp/tools/ap-update-step'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
beforeAll(async () => {
    app = await setupTestEnvironment()
})
afterAll(async () => {
    await teardownTestEnvironment()
})

async function routerDraft() {
    const ctx = await createTestContext(app)
    const mcp: ProjectScopedMcpServer = { id: apId(), created: '', updated: '', projectId: ctx.project.id, platformId: null, type: McpServerType.PROJECT, token: apId(), disabledTools: [] }
    const created = await apCreateFlowTool({ mcp, userId: ctx.user.id }, app.log).execute({ flowName: 'Router update regression' })
    const flowId = created.structuredContent!.flowId as string
    await apAddStepTool({ mcp, userId: ctx.user.id }, app.log).execute({ flowId, parentStepName: 'trigger', stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER, stepType: FlowActionType.ROUTER, displayName: 'Qualify' })
    return { ctx, mcp, flowId }
}

const conditions = [[{ firstValue: '{{trigger[\'output\'].category}}', operator: 'TEXT_EXACTLY_MATCHES', secondValue: 'qualified' }]]

describe('MCP router updates', () => {
    it.each([
        { input: { branches: [{ conditions }] } },
        { auth: 'connection-external-id' },
        { input: {}, auth: '' },
    ])('rejects unsupported router input/auth without writing or claiming success: %j', async (unsupported) => {
        const { mcp, flowId } = await routerDraft()
        const before = await apReadStepSettingsTool(mcp, app.log).execute({ flowId, stepName: 'step_1' })
        const getService = flows.flowService
        const update = vi.fn()
        const serviceSpy = vi.spyOn(flows, 'flowService').mockImplementation(log => ({ ...getService(log), update }))
        try {
            const result = await apUpdateStepTool({ mcp }, app.log).execute({ flowId, stepName: 'step_1', displayName: 'Must not rename', ...unsupported })
            expect(result.isError).toBe(true)
            expect(result.content[0].text).toContain('ap_update_branch')
            expect(result.content[0].text).toContain('ap_add_branch')
            expect(result.content[0].text).not.toContain('✅')
            expect(update).not.toHaveBeenCalled()
        }
        finally {
            serviceSpy.mockRestore()
        }
        const after = await apReadStepSettingsTool(mcp, app.log).execute({ flowId, stepName: 'step_1' })
        expect(after.structuredContent).toEqual(before.structuredContent)
    })

    it('stores the empty router draft as invalid, then persists conditions through the branch editor', async () => {
        const { mcp, flowId } = await routerDraft()
        const before = await apReadStepSettingsTool(mcp, app.log).execute({ flowId, stepName: 'step_1' })
        expect(before.structuredContent).toMatchObject({ valid: false, settings: { branches: [{ conditions: [[]] }, {}] } })
        const result = await apUpdateBranchTool({ mcp }, app.log).execute({ flowId, routerStepName: 'step_1', branchIndex: 0, conditions })
        expect(result.content[0].text).toContain('✅')
        const after = await apReadStepSettingsTool(mcp, app.log).execute({ flowId, stepName: 'step_1' })
        expect(after.structuredContent).toMatchObject({ valid: true, settings: { branches: [{ conditions }, {}] } })
    })
})
