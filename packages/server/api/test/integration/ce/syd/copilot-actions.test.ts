import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../../../../src/app/database'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { sydApprovalGate } from '../../../../src/app/syd/copilot/approval-gate'
import { sydCopilotContext } from '../../../../src/app/syd/copilot/copilot-context'
import { sydConversationService } from '../../../../src/app/syd/copilot/conversation-service'
import { sydConversationRpc } from '../../../../src/app/syd/copilot/rpc/conversation-rpc'
import { sydRunOperations } from '../../../../src/app/syd/copilot/rpc/run-operations'
import { sydCopilotActions } from '../../../../src/app/syd/copilot/tools/copilot-actions'
import { sydChatAgentTools } from '../../../../src/app/syd/copilot/tools/chat-agent-tools'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'

const boundaries = vi.hoisted(() => ({
    piece: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Done' }], structuredContent: { success: true } }),
    code: vi.fn().mockResolvedValue({ status: 'succeeded', output: { count: 1 } }),
    metadata: vi.fn().mockResolvedValue({ name: '@activepieces/piece-test', displayName: 'Test', version: '1.0.0', auth: null, actions: { list_records: { displayName: 'List records' } } }),
}))
vi.mock('../../../../src/app/mcp/tools/flow-run-utils', async (original) => ({ ...await original<object>(), executePieceActionRun: boundaries.piece, executeCodeActionRun: boundaries.code }))
vi.mock('../../../../src/app/pieces/metadata/piece-metadata-service', () => ({ pieceMetadataService: () => ({ get: boundaries.metadata }) }))
const log = Fastify().log
beforeAll(async () => { await initializeDatabase({ runMigrations: false }) })
beforeEach(() => { boundaries.metadata.mockResolvedValue({ name: '@activepieces/piece-test', displayName: 'Test', version: '1.0.0', auth: null, actions: { list_records: { displayName: 'List records' } } }); boundaries.piece.mockResolvedValue({ content: [{ type: 'text', text: 'Done' }], structuredContent: { success: true } }); boundaries.code.mockResolvedValue({ status: 'succeeded', output: { count: 1 } }) })
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
afterAll(async () => { await redisConnections.destroy(); await databaseConnection().destroy() })
async function context() {
    const data = await mockAndSaveBasicSetup()
    const actor = { platformId: data.mockPlatform.id, userId: data.mockOwner.id }
    const row = await sydConversationService(log).createConversation({ ...actor, request: { projectId: data.mockProject.id } })
    return { ...actor, projectId: data.mockProject.id, conversationId: row.id, projects: [data.mockProject], log }
}

describe('Syd direct action and code boundaries', () => {
    it('keeps exploration read-only and validates direct action project selection', async () => {
        const input = await context()
        expect(await sydCopilotActions.executeCrossProjectTool({ ...input, toolName: 'ap_explore_data', toolInput: { pieceName: 'test', actionName: 'create_record' } })).toMatchObject({ success: false })
        expect(boundaries.piece).not.toHaveBeenCalled()
        expect(await sydCopilotActions.runAgentAction({ ...input, projects: [], availableProjectIds: [], toolInput: { pieceName: 'test', actionName: 'list_records' } })).toMatchObject({ success: false })
        await sydCopilotActions.executeCrossProjectTool({ ...input, toolName: 'ap_explore_data', toolInput: { pieceName: 'test', actionName: 'list_records' } })
        expect(boundaries.piece).toHaveBeenCalledWith(expect.objectContaining({ projectId: input.projectId, actionName: 'list_records' }))
    })
    it('audits direct mutations and does not audit read-only exploration', async () => {
        const input = await context()
        const audit = vi.spyOn(sydRunOperations, 'recordAgentToolUse').mockImplementation(() => undefined)
        await sydCopilotActions.executeCrossProjectTool({ ...input, toolName: 'ap_execute_action', toolInput: { pieceName: 'test', actionName: 'create_record' } })
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ conversationId: input.conversationId, outcome: 'SUCCEEDED', action: expect.objectContaining({ actionName: 'create_record', kind: 'PIECE' }) }))
        audit.mockClear()
        await sydCopilotActions.executeCrossProjectTool({ ...input, toolName: 'ap_explore_data', toolInput: { pieceName: 'test', actionName: 'list_records' } })
        expect(audit).not.toHaveBeenCalled()
    })

    it('reuses selected accounts and rejects a selection from an inaccessible project', async () => {
        const input = await context()
        await sydApprovalGate.storeSelectedConnection({ conversationId: input.conversationId, pieceName: '@activepieces/piece-test', externalId: 'connected', label: 'Account', projectId: input.projectId })
        const discovered = await sydCopilotActions.executeCrossProjectTool({ ...input, toolName: 'ap_discover_action_auth', toolInput: { pieceName: 'test' } })
        expect(discovered).toMatchObject({ alreadyConnected: true, auth: 'connected' })
        expect(boundaries.metadata).not.toHaveBeenCalled()
        await sydCopilotActions.runAgentAction({ ...input, availableProjectIds: [], toolInput: { pieceName: 'test', actionName: 'list_records' } })
        expect(boundaries.piece).not.toHaveBeenCalled()
    })
    it('persists oversized action results as a readable conversation artifact', async () => {
        const input = await context()
        const offload = sydCopilotActions.buildActionRunOffload({ ...input, pieceName: 'test', actionName: 'list_records' })
        expect(offload?.thresholdBytes).toBe(65536)
        const preview = await offload?.handle({ payload: { rows: 'x'.repeat(70000) }, byteSize: 70000, label: 'Result', statusNote: 'Done' })
        expect(preview).toContain('saved as file')
        const fileId = preview?.match(/saved as file ([a-zA-Z0-9]+)/)?.[1]
        if (!fileId) throw new Error('Missing offloaded file')
        expect((await sydConversationRpc(log).readAgentFile({ ...input, fileId })).data.toString()).toContain('rows')
    })
    it('runs code with scoped JSON attachments and saves produced files', async () => {
        const input = await context()
        const attached = await sydConversationRpc(log).saveAgentFile({ ...input, fileName: 'data.json', mediaType: 'application/json', data: Buffer.from('{"n":3}') })
        boundaries.code.mockResolvedValueOnce({ status: 'succeeded', output: { count: 1, files: [{ name: 'report.txt', mimeType: 'text/plain', base64: 'SGVsbG8=' }] } })
        const result = await sydCopilotActions.runAgentCode({ ...input, toolName: 'ap_run_code', toolInput: { code: 'return inputs.data', inputFileIds: [attached.fileId] } })
        expect(boundaries.code).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ data: { n: 3 }, files: expect.any(Array) }) }))
        expect(result.producedFiles).toHaveLength(1)
        const file = result.producedFiles[0]
        expect((await sydConversationRpc(log).readAgentFile({ ...input, fileId: file.fileId })).data.toString()).toBe('Hello')
        expect((await sydCopilotActions.runAgentCode({ ...input, toolName: 'ap_run_code', toolInput: { code: '' } })).text).toContain('required')
        boundaries.code.mockResolvedValueOnce({ status: 'timeout' })
        expect((await sydCopilotActions.runAgentCode({ ...input, toolName: 'ap_run_code', toolInput: { code: 'long' } })).text).toContain('120s')
    })
    it('discovers auth-free pieces and queries empty project resources using real SQL', async () => {
        const input = await context()
        expect(await sydCopilotActions.findConnectionsForPiece({ ...input, pieceName: 'test' })).toMatchObject({ noAuthRequired: true })
        expect(await sydCopilotActions.connectionsForProjects({ ...input })).toEqual([])
        for (const resource of ['flows', 'tables', 'runs', 'connections']) expect(await sydCopilotActions.executeCrossProjectTool({ ...input, toolName: 'ap_list_across_projects', toolInput: { resource } })).toHaveProperty('content')
    })
    it('creates, updates, adds and removes conditional agent tools and rejects duplicate edits', async () => {
        const input = await context()
        vi.spyOn(sydCopilotContext, 'agentsSurfaceAvailable').mockResolvedValue(true)
        await sydChatAgentTools.execute({ ...input, toolName: 'ap_create_agent', toolInput: { displayName: 'Researcher', instructions: 'Research prospects' } })
        const listed = await sydChatAgentTools.execute({ ...input, toolName: 'ap_list_agents', toolInput: {} })
        if (!Array.isArray(listed) || typeof listed[0]?.agentId !== 'string') throw new Error('Missing created agent')
        const agentId = listed[0].agentId
        await sydChatAgentTools.execute({ ...input, toolName: 'ap_update_agent', toolInput: { agentId, instructions: 'Research leads' } })
        expect(await sydChatAgentTools.execute({ ...input, toolName: 'ap_add_agent_tool', toolInput: { agentId, pieceName: 'test', actionNames: ['list_records'] } })).toMatchObject({ agentId })
        expect(await sydChatAgentTools.execute({ ...input, toolName: 'ap_add_agent_tool', toolInput: { agentId, pieceName: 'test', actionNames: ['list_records'] } })).toHaveProperty('error')
        expect(await sydChatAgentTools.execute({ ...input, toolName: 'ap_remove_agent_tool', toolInput: { agentId, pieceName: 'test', actionNames: ['list_records'] } })).toMatchObject({ agentId })
        expect(await sydChatAgentTools.execute({ ...input, toolName: 'ap_remove_agent_tool', toolInput: { agentId, pieceName: 'test', actionNames: ['list_records'] } })).toHaveProperty('error')
    })
})
