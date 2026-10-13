import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { AgentVisibility } from '@activepieces/shared'
import { EntityManager, In } from 'typeorm'
import { SydChatManagedAgentEntity } from './models/chat-managed-agent.entity'

async function assertReferencesResolve({ projectId, agentExternalIds, entityManager }: { projectId: string, agentExternalIds: string[], entityManager: EntityManager }): Promise<void> {
    const ids = [...new Set(agentExternalIds)]
    if (!ids.length) return
    const rows = await entityManager.getRepository(SydChatManagedAgentEntity).find({ where: { projectId, externalId: In(ids) }, lock: { mode: 'pessimistic_read' } })
    if (rows.length !== ids.length || rows.some((agent) => !agent.published || agent.visibility !== AgentVisibility.PROJECT)) throw new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message: 'Every linked agent must be published and shared with this mission’s project' } })
}

export const sydAgentPublication = { assertReferencesResolve }
