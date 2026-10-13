import { ActivepiecesError, ErrorCode, Permission } from '@activepieces/core-utils'
import { FilterOperator } from '@activepieces/shared'
import { generateText, LanguageModel, Output } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { resolvePermissionChecker } from '../../../mcp/mcp-permissions'
import { fieldService } from '../../../tables/field/field.service'
import { recordService } from '../../../tables/record/record.service'
import { tableService } from '../../../tables/table/table.service'

async function search({ tableId, projectId, userId, query, model, log }: { tableId: string, projectId: string, userId: string, query: string, model: LanguageModel, log: FastifyBaseLogger }) {
    const permission = await resolvePermissionChecker({ projectId, userId, log })
    if (permission.check(Permission.READ_TABLE, 'agent-table-knowledge')) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'This table is unavailable to the agent' } })
    const [table, fields] = await Promise.all([tableService.getOneOrThrow({ projectId, id: tableId }), fieldService.getAll({ projectId, tableId })])
    if (!fields.length) return { tableName: table.name, records: [], note: 'This table has no fields yet.' }
    const schema = z.object({ filters: z.array(z.object({ fieldId: z.enum(fields.map((field) => field.id)), operator: z.enum([FilterOperator.EQ, FilterOperator.NEQ, FilterOperator.GT, FilterOperator.GTE, FilterOperator.LT, FilterOperator.LTE, FilterOperator.CO, FilterOperator.EXISTS, FilterOperator.NOT_EXISTS]), value: z.string().nullable() })).max(8, 'Too many table filters.') })
    const { output } = await generateText({ model, output: Output.json(), prompt: `Translate this table lookup into filters: ${query}. Fields: ${JSON.stringify(fields.map(({ id, name, type }) => ({ id, name, type })))}. Filters use AND. Use an empty filters array for a broad request; never invent a value the request does not supply. Return JSON matching ${JSON.stringify(z.toJSONSchema(schema))}.` })
    const parsed = schema.parse(output)
    const filters = parsed.filters.map((filter) => ({ ...filter, value: filter.value ?? '' }))
    const page = await recordService.list({ projectId, tableId, fields, cursorRequest: null, limit: 50, filters })
    return { tableName: table.name, records: page.data.map((record) => ({ id: record.id, values: Object.fromEntries(Object.values(record.cells).map((cell) => [cell.fieldName, cell.value])) })), limit: 50, truncated: page.next !== null }
}

export const sydConfiguredTable = { search }
