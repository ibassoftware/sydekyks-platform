import { isDeepStrictEqual } from 'node:util'
import { Permission } from '@activepieces/core-utils'
import { AgentConfigResponse, AgentRunSource, McpToolDefinition, ProjectScopedMcpServer } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { resolvePermissionChecker } from '../mcp/mcp-permissions'
import { mcpServerService } from '../mcp/mcp-service'
import { apAddStepTool } from '../mcp/tools/ap-add-step'
import { apBuildFlowTool } from '../mcp/tools/ap-build-flow'
import { apCreateFlowTool } from '../mcp/tools/ap-create-flow'
import { apCreateFolderTool } from '../mcp/tools/ap-create-folder'
import { apCreateTableTool } from '../mcp/tools/ap-create-table'
import { apFindRecordsTool } from '../mcp/tools/ap-find-records'
import { apFlowStructureTool } from '../mcp/tools/ap-flow-structure'
import { apGetPiecePropsTool } from '../mcp/tools/ap-get-piece-props'
import { apInsertRecordsTool } from '../mcp/tools/ap-insert-records'
import { apListConnectionsTool } from '../mcp/tools/ap-list-connections'
import { apListFlowsTool } from '../mcp/tools/ap-list-flows'
import { apListFoldersTool } from '../mcp/tools/ap-list-folders'
import { apListTablesTool } from '../mcp/tools/ap-list-tables'
import { apReadStepSettingsTool } from '../mcp/tools/ap-read-step-settings'
import { apRenameFlowTool } from '../mcp/tools/ap-rename-flow'
import { apResearchPiecesTool } from '../mcp/tools/ap-research-pieces'
import { apUpdateRecordTool } from '../mcp/tools/ap-update-record'
import { apUpdateStepTool } from '../mcp/tools/ap-update-step'
import { apUpdateTriggerTool } from '../mcp/tools/ap-update-trigger'
import { apValidateFlowTool } from '../mcp/tools/ap-validate-flow'
import { staticMcpSchemaScope } from '../mcp/tools/static-schema-scope'
import { projectService } from '../project/project-service'
import { sydApprovalGate } from '../syd/copilot/approval-gate'
import { sydRunOperations } from '../syd/copilot/rpc/run-operations'
import { hostingFail } from './hosting-transactions'

// Internal configuration/metadata tools, NOT an authenticated remote MCP client.
// No execution, dynamic property callbacks, publication/hook activation, retries,
// raw code, deletion or cross-project switching is admitted by this surface.
const NAMES = [
    'ap_build_flow', 'ap_create_flow', 'ap_create_folder', 'ap_list_flows', 'ap_list_folders',
    'ap_flow_structure', 'ap_read_step_settings', 'ap_rename_flow', 'ap_update_trigger',
    'ap_add_step', 'ap_update_step', 'ap_validate_flow', 'ap_research_pieces', 'ap_get_piece_props',
    'ap_list_connections', 'ap_create_table', 'ap_list_tables', 'ap_find_records',
    'ap_insert_records', 'ap_update_record',
] as const
export const hostedBuilderToolNames = new Set<string>(NAMES)

function definitions(mcp: ProjectScopedMcpServer, userId: string, log: FastifyBaseLogger): McpToolDefinition[] {
    const context = { mcp, userId }
    const schema = apGetPiecePropsTool(mcp, log, { staticOnly: true })
    // Never expose resolver/auth/context arguments or instructions suggesting
    // unmetered execution through the static schema adapter.
    const staticSchema: McpToolDefinition = {
        ...schema, permission: Permission.READ_FLOW,
        description: 'Read static input and output schemas for a catalogue Gadget action or trigger. Dynamic dropdowns require configuration in the Mission editor.',
        inputSchema: { pieceName: z.string(), actionOrTriggerName: z.string(), type: z.enum(['action', 'trigger']) },
        execute: async args => {
            const result = await schema.execute(args)
            if (!result.structuredContent) return result
            return { content: [{ type: 'text', text: JSON.stringify(result.structuredContent) }], structuredContent: result.structuredContent }
        },
    }
    return [
        apBuildFlowTool(context, log), apCreateFlowTool(context, log), apCreateFolderTool(mcp, log),
        apListFlowsTool(mcp, log), apListFoldersTool(mcp, log), apFlowStructureTool(mcp, log),
        apReadStepSettingsTool(mcp, log), apRenameFlowTool(context, log), apUpdateTriggerTool(context, log),
        apAddStepTool(context, log), apUpdateStepTool(context, log), apValidateFlowTool(context, log),
        apResearchPiecesTool(mcp, log), staticSchema, apListConnectionsTool(mcp, log),
        apCreateTableTool(mcp, log), apListTablesTool(mcp, log), apFindRecordsTool(mcp, log),
        apInsertRecordsTool(mcp, log), apUpdateRecordTool(mcp, log),
    ]
}

type Scope = { projectId: string, platformId: string, userId: string, log: FastifyBaseLogger }
async function available(scope: Scope): Promise<McpToolDefinition[]> {
    const { projectId, platformId, userId, log } = scope
    const project = await projectService(log).getOneOrThrow(projectId)
    if (project.platformId !== platformId) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
    const [mcp, platformDisabled, checker] = await Promise.all([
        mcpServerService(log).getByProjectId(projectId),
        mcpServerService(log).listPlatformDisabledTools({ platformId }),
        resolvePermissionChecker({ userId, projectId, log }),
    ])
    const disabled = new Set([...mcp.disabledTools ?? [], ...platformDisabled])
    return definitions({ ...mcp, projectId }, userId, log).filter(tool => !disabled.has(tool.title) && !checker.check(tool.permission, tool.title))
}

export async function hostedBuilderConfiguration(scope: Scope): Promise<NonNullable<AgentConfigResponse['hostedBuilderTools']>> {
    return (await available(scope)).map(tool => ({
        name: tool.title,
        description: tool.description.replace(/\bActivepieces\b/gi, 'Sydekyks').slice(0, 420),
        inputSchema: z.toJSONSchema(z.object(tool.inputSchema), { unrepresentable: 'any' }) as Record<string, unknown>,
        readOnly: tool.annotations?.readOnlyHint === true,
    }))
}

export async function executeHostedBuilderTool({ source, toolName, toolInput, conversationId, runId, ...scope }: Scope & { source: AgentRunSource, toolName: string, toolInput: Record<string, unknown>, conversationId: string, runId: string }) {
    if (Buffer.byteLength(JSON.stringify(toolInput)) > 32768) hostingFail('HOSTING_TOOL_INPUT_LIMIT')
    if (source !== AgentRunSource.CHAT || !hostedBuilderToolNames.has(toolName)) hostingFail('HOSTING_TOOL_NOT_METERED')
    const tool = (await available(scope)).find(candidate => candidate.title === toolName)
    if (!tool) hostingFail('HOSTING_TOOL_ACCESS_DENIED')
    const { approvedGateId, ...requested } = toolInput
    // Explicit project substitutions are denied before Zod strips unknown keys.
    for (const [field, expected] of Object.entries({ projectId: scope.projectId, platformId: scope.platformId, userId: scope.userId, conversationId, runId })) {
        if (field in requested && requested[field] !== expected) hostingFail('HOSTING_AI_SEGMENT_DENIED')
        delete requested[field]
    }
    if (!tool.annotations?.readOnlyHint && await sydRunOperations.turnHasRead({ conversationId, runId })) {
        if (typeof approvedGateId !== 'string') hostingFail('HOSTING_TOOL_APPROVAL_REQUIRED')
        const decision = await sydApprovalGate.checkDecision({ gateId: approvedGateId })
        if (decision === 'pending' || !decision.approved || decision.approvedToolName !== toolName || decision.approvedConversationId !== conversationId || decision.approvedRunId !== runId || !isDeepStrictEqual(decision.approvedInput, requested) || !await sydApprovalGate.consumeApproval({ gateId: approvedGateId })) hostingFail('HOSTING_TOOL_APPROVAL_REQUIRED')
    }
    const parsed = z.object(tool.inputSchema).strict().parse(requested)
    const result = await staticMcpSchemaScope.run(true, () => tool.execute(parsed))
    if ((tool.annotations?.readOnlyHint || toolName === 'ap_update_record') && !['ap_research_pieces', 'ap_get_piece_props'].includes(toolName)) await sydRunOperations.markTurnAsHavingRead({ conversationId, runId })
    // Retain machine compatibility identifiers; the prompt controls user prose.
    return result
}
