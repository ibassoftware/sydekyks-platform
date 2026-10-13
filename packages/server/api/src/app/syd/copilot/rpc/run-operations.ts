import { ActivepiecesError, ErrorCode, sanitizeObjectForPostgresql, tryCatchSync } from '@activepieces/core-utils'
import { AgentActionOutcome, AgentActionRef, AgentConversation, AgentConversationStatus, AgentRunSource, agentToolClassification, ApplicationEventName } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { databaseConnection } from '../../../database/database-connection'
import { distributedStore } from '../../../database/redis-connections'
import { applicationEvents } from '../../../helper/application-events'
import { sydAgentRuntime } from '../agent-runtime'
import { sydConversationService } from '../conversation-service'
import { SydConversationEntity } from '../models/conversation.entity'

async function conversationForRpc({ conversationId, platformId }: { conversationId: string, platformId?: string }): Promise<AgentConversation> {
    const scope = { id: conversationId, ...(platformId ? { platformId } : {}) }
    const row = await databaseConnection().getRepository(SydConversationEntity).findOneBy({ ...scope, source: AgentRunSource.CHAT }) ?? await sydAgentRuntime.repo().findOneBy(scope)
    if (!row) throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: conversationId, entityType: 'conversation' } })
    return row
}

async function loadOrStartConversation({ conversationId, platformId, userId, source, log }: { conversationId: string, platformId: string, userId: string, source?: AgentRunSource, log: FastifyBaseLogger }): Promise<AgentConversation> {
    if (source !== undefined && source !== AgentRunSource.CHAT) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: { message: 'Syd configuration requires CHAT' } })
    return sydConversationService(log).getConversationOrThrow({ id: conversationId, platformId, userId })
}

async function updateConversationForRun({ conversationId, runId, updates, parameters, onlyWhileStreaming, platformId }: UpdateRunParams): Promise<boolean> {
    const row = await conversationForRpc({ conversationId, platformId })
    const repo = row.source === AgentRunSource.CHAT ? databaseConnection().getRepository(SydConversationEntity) : sydAgentRuntime.repo()
    const query = repo.createQueryBuilder().update().set(sanitizeObjectForPostgresql(updates))
        .where({ id: row.id, platformId: row.platformId, userId: row.userId, source: row.source })
    if (runId !== undefined) query.andWhere('("activeRunId" IS NULL OR "activeRunId" = :runId)', { runId })
    if (onlyWhileStreaming) query.andWhere('status = :status', { status: AgentConversationStatus.STREAMING })
    if (parameters) query.setParameters(parameters)
    const result = await query.returning('id').execute()
    return Array.isArray(result.raw) && result.raw.length > 0
}

async function pinConnectionToAgent({ conversationId, platformId, userId, log }: { conversationId: string, pieceName: string, externalId: string, platformId: string, userId: string, log: FastifyBaseLogger }): Promise<void> {
    await sydConversationService(log).getConversationOrThrow({ id: conversationId, platformId, userId })
}

function byteLengthOf(value: unknown): number {
    return tryCatchSync(() => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')).data ?? -1
}
function turnReadKey({ conversationId, runId }: { conversationId: string, runId: string }): string {
    return `syd:turn-read:v1:${conversationId}:${runId}`
}

async function markTurnAsHavingRead({ conversationId, runId }: { conversationId: string, runId?: string }): Promise<void> {
    if (runId) await distributedStore.put(turnReadKey({ conversationId, runId }), true, 3600)
}

async function turnHasRead({ conversationId, runId }: { conversationId: string, runId?: string }): Promise<boolean> {
    return runId ? await distributedStore.get<boolean>(turnReadKey({ conversationId, runId })) === true : true
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function outcomeOfToolResult(result: unknown): AgentActionOutcome {
    if (!isObject(result)) return AgentActionOutcome.SUCCEEDED
    const structured = result.structuredContent
    if (result.success === false || result.isError || (isObject(structured) && (structured.success === false || typeof structured.errorSummary === 'string'))) return AgentActionOutcome.FAILED
    const first = Array.isArray(result.content) ? result.content[0] : null
    return isObject(first) && typeof first.text === 'string' && agentToolClassification.hasFailureTextPrefix(first.text) ? AgentActionOutcome.FAILED : AgentActionOutcome.SUCCEEDED
}

function recordAgentToolUse({ run, conversationId, flow, action, outcome, connection, log }: AuditParams): void {
    applicationEvents(log).sendUserEvent({ platformId: run.platformId, projectId: run.projectId, userId: run.userId }, {
        action: ApplicationEventName.AGENT_ACTION_EXECUTED,
        data: { source: run.source ?? AgentRunSource.CHAT, action,
            ...(conversationId ? { conversation: { id: conversationId, source: run.source ?? AgentRunSource.CHAT } } : {}),
            ...(flow ? { flow } : {}), ...(outcome ? { outcome } : {}),
            ...(connection.externalId ? { connection: { externalId: connection.externalId, ...(connection.label ? { label: connection.label } : {}) } } : {}),
        },
    })
}

export const sydRunOperations = { conversationForRpc, loadOrStartConversation, updateConversationForRun, pinConnectionToAgent, byteLengthOf, turnReadKey, markTurnAsHavingRead, turnHasRead, isObject, outcomeOfToolResult, recordAgentToolUse }
export const CONNECTION_INVENTORY_LIMIT = 200

type UpdateRunParams = { conversationId: string, platformId?: string, runId?: string, updates: Record<string, unknown>, parameters?: Record<string, unknown>, onlyWhileStreaming?: boolean }
type AuditParams = { run: { platformId: string, projectId: string, userId: string, source?: AgentRunSource }, conversationId?: string, flow?: { id: string, runId: string }, action: AgentActionRef, outcome?: AgentActionOutcome, connection: { externalId?: string, label?: string }, log: FastifyBaseLogger }
