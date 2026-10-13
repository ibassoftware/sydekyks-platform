import { apId } from '@activepieces/core-utils'
import { Agent, AgentConfig, AgentIcon, AgentVisibility, ColorName, AgentConversationStatus, PersistedAgentPartType, PersistedAgentRole } from '@activepieces/shared'
import Fastify from 'fastify'
import { DataSource, EntitySchema } from 'typeorm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApIdSchema } from '../../../../src/app/database/database-common'
import { publishHooksFactory } from '../../../../src/app/flows/flow/flow-publish-hooks'
import { sydChatAgentAdministration } from '../../../../src/app/syd/copilot/tools/chat-agent-administration'
import { SydChatManagedAgentEntity } from '../../../../src/app/syd/copilot/models/chat-managed-agent.entity'
import { sydCopilotContext } from '../../../../src/app/syd/copilot/copilot-context'
import { sydPersonalizationStore } from '../../../../src/app/syd/copilot/personalization/personalization-store'
import { sydConversationRpc } from '../../../../src/app/syd/copilot/rpc/conversation-rpc'
import { sydConversationService } from '../../../../src/app/syd/copilot/conversation-service'
import { sydConversationUsage } from '../../../../src/app/syd/copilot/conversation-usage'
import { SydConversationEntity } from '../../../../src/app/syd/copilot/models/conversation.entity'
import { SydPersonalizationEntity } from '../../../../src/app/syd/copilot/models/personalization.entity'
import { SydUserMemoryEntity } from '../../../../src/app/syd/copilot/models/user-memory.entity'

const state = vi.hoisted((): { connection: DataSource | null } => ({ connection: null }))
vi.mock('../../../../src/app/database/database-connection', async (original) => {
    const actual = await original<typeof import('../../../../src/app/database/database-connection')>()
    return { ...actual, databaseConnection: () => { if (!state.connection) throw new Error('Test database is not ready'); return state.connection } }
})

vi.mock('../../../../src/app/mcp/mcp-permissions', () => ({ resolvePermissionChecker: async () => ({ check: () => undefined }) }))

const log = Fastify().log
const service = sydConversationService(log)
const idColumn = { ...ApIdSchema, primary: true }
const platform = new EntitySchema<{ id: string }>({ name: 'platform', columns: { id: idColumn } })
const user = new EntitySchema<{ id: string, platformId: string }>({ name: 'user', columns: { id: idColumn, platformId: ApIdSchema } })
const project = new EntitySchema<{ id: string, platformId: string, ownerId: string }>({ name: 'project', columns: { id: idColumn, platformId: ApIdSchema, ownerId: ApIdSchema } })
const folder = new EntitySchema<{ id: string }>({ name: 'folder', columns: { id: idColumn } })
const flow = new EntitySchema<{ id: string, projectId: string, publishedVersionId: string }>({ name: 'flow', columns: { id: idColumn, projectId: ApIdSchema, publishedVersionId: ApIdSchema } })
const version = new EntitySchema<{ id: string, flowId: string, displayName: string, agentIds: string[] }>({ name: 'flow_version', columns: { id: idColumn, flowId: ApIdSchema, displayName: { type: String }, agentIds: { type: 'varchar', array: true } } })

describe.skipIf(process.env.SYD_TEST_POSTGRES !== 'true')('Syd concurrency on isolated PostgreSQL', () => {
    beforeAll(async () => {
        state.connection = new DataSource({ type: 'postgres', host: '127.0.0.1', port: 55432, username: 'syd', password: 'syd-test', database: 'syd', synchronize: true, dropSchema: true, entities: [platform, user, project, folder, flow, version, SydChatManagedAgentEntity, SydConversationEntity, SydUserMemoryEntity, SydPersonalizationEntity] })
        await state.connection.initialize()
    })
    afterAll(async () => { await state.connection?.destroy(); state.connection = null })

    async function context() {
        const connection = state.connection
        if (!connection) throw new Error('No test connection')
        const actor = { platformId: apId(), userId: apId() }
        await connection.getRepository(platform).save({ id: actor.platformId })
        await connection.getRepository(user).save({ id: actor.userId, platformId: actor.platformId })
        return { connection, actor }
    }

    it('serializes simultaneous claims into an ownership chain', async () => {
        const { connection, actor } = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        const initial = { ...actor, conversationId: row.id, runId: apId() }
        await sydCopilotContext.claimConversationForRun(initial)
        await sydCopilotContext.acquireStreamingLock(initial)
        const blocker = connection.createQueryRunner()
        await blocker.startTransaction()
        await blocker.manager.getRepository(SydConversationEntity).findOne({ where: { id: row.id, platformId: actor.platformId }, lock: { mode: 'pessimistic_write' } })
        const first = { ...initial, runId: apId() }
        const second = { ...initial, runId: apId() }
        const claims = [sydCopilotContext.claimConversationForRun(first), sydCopilotContext.claimConversationForRun(second)]
        await new Promise((resolve) => setTimeout(resolve, 50))
        await blocker.commitTransaction()
        const results = await Promise.all(claims)
        expect(results.filter((result) => result.preemptedRunId === initial.runId)).toHaveLength(1)
        const newer = results[0].preemptedRunId === initial.runId ? second : first
        const older = newer === first ? second : first
        expect((await service.getConversationOrThrow({ ...actor, id: row.id })).activeRunId).toBe(newer.runId)
        expect(await sydCopilotContext.acquireStreamingLock(older)).toBe('superseded')
        expect(await sydCopilotContext.acquireStreamingLock(newer)).toBe('acquired')
        await blocker.release()
    })

    it('merges simultaneous memory additions under a real row lock', async () => {
        const { connection, actor } = await context()
        await sydCopilotContext.saveUserMemory({ ...actor, memories: ['Original'] })
        const blocker = connection.createQueryRunner()
        await blocker.startTransaction()
        await blocker.manager.getRepository(SydUserMemoryEntity).findOne({ where: actor, lock: { mode: 'pessimistic_write' } })
        const writes = ['First', 'Second'].map((fact) => sydCopilotContext.saveUserMemory({ ...actor, memories: ['Original', fact], baseMemories: ['Original'] }))
        await new Promise((resolve) => setTimeout(resolve, 50))
        await blocker.commitTransaction()
        await Promise.all(writes)
        expect([...(await sydCopilotContext.getUserMemory(actor)).memories].sort()).toEqual(['First', 'Original', 'Second'])
        await blocker.release()
    })

    it('keeps an append committed between feedback read and feedback patch', async () => {
        const { connection, actor } = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        const repo = connection.getRepository(SydConversationEntity)
        await repo.update({ id: row.id, platformId: actor.platformId }, { uiMessages: [{ role: PersistedAgentRole.ASSISTANT, parts: [{ type: PersistedAgentPartType.TEXT, text: 'Reply' }] }] })
        const blocker = connection.createQueryRunner()
        await blocker.startTransaction()
        await blocker.manager.getRepository(SydConversationEntity).findOne({ where: { id: row.id, platformId: actor.platformId }, lock: { mode: 'pessimistic_write' } })
        let acknowledge: (() => void) | undefined
        const snapshotRead = new Promise<void>((resolve) => { acknowledge = resolve })
        const get = service.getConversationOrThrow.bind(service)
        const reader = vi.spyOn(service, 'getConversationOrThrow').mockImplementation(async (scope) => { const result = await get(scope); acknowledge?.(); return result })
        const patch = service.setMessageFeedback({ ...actor, id: row.id, messageIndex: 0, request: { rating: 'up' } })
        await snapshotRead
        await blocker.query('UPDATE syd_conversation SET "uiMessages" = "uiMessages" || $1::jsonb WHERE id = $2 AND "platformId" = $3', [JSON.stringify([{ role: PersistedAgentRole.USER, parts: [] }]), row.id, actor.platformId])
        await blocker.commitTransaction()
        await patch
        reader.mockRestore()
        const stored = await service.getConversationOrThrow({ ...actor, id: row.id })
        expect(stored.uiMessages).toHaveLength(2)
        expect(stored.uiMessages?.[0].feedback?.rating).toBe('up')
        await blocker.release()
    })

    it('atomically rounds and increments simultaneous credit charges', async () => {
        const { actor } = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        await Promise.all(Array.from({ length: 20 }, () => sydConversationUsage(log).addConversationCredits({ conversationId: row.id, credits: 0.6 })))
        expect((await service.getConversationOrThrow({ ...actor, id: row.id })).aiCredits).toBe(20)
    })
    it('sanitizes memory, profiles and recovered failure JSON on real PostgreSQL', async () => {
        const { actor } = await context()
        expect(await sydCopilotContext.saveUserMemory({ ...actor, instructions: 'Be\u0000 brief', memories: ['One\u0000 fact'] })).toEqual({ instructions: 'Be brief', memories: ['One fact'] })
        await sydPersonalizationStore.writeUserRow({ ...actor, patch: { profile: { companyName: 'Syd\u0000', displayName: 'Syd', website: '', description: 'Work', industry: 'Software' } } })
        expect((await sydPersonalizationStore.findRow(actor))?.profile?.companyName).toBe('Syd')
        const row = await service.createConversation({ ...actor, request: {} })
        await sydConversationRpc(log).saveAgentMessages({ conversationId: row.id, messages: [], uiMessages: [], failure: { message: 'Failed\u0000 safely', userMessage: 'Help\u0000' } })
        expect(JSON.stringify((await service.getConversationOrThrow({ ...actor, id: row.id })).uiMessages)).toContain('Failed safely')
    })

    it('refuses publishing a draft changed after review on real PostgreSQL', async () => {
        const { connection, actor } = await context()
        const projectId = apId()
        await connection.getRepository(project).save({ id: projectId, platformId: actor.platformId, ownerId: actor.userId })
        const draft = AgentConfig.parse({ instructions: 'Reviewed brief', provider: null, providerConfigId: null, modelName: null })
        const agent: Agent = await connection.getRepository(SydChatManagedAgentEntity).save({ id: apId(), projectId, ownerId: actor.userId, externalId: apId(), displayName: 'Researcher', description: null, icon: AgentIcon.SPARKLES, color: ColorName.PURPLE, visibility: AgentVisibility.PROJECT, sharedWithUserIds: [], folderId: null, draft, published: null })
        const hooks = publishHooksFactory.get(log)
        let changed = false
        const boundary = vi.spyOn(publishHooksFactory, 'get').mockReturnValue({ ...hooks, routePublish: async () => {
            if (!changed) { changed = true; await connection.getRepository(SydChatManagedAgentEntity).save({ id: agent.id, draft: { ...draft, instructions: 'Concurrent edit' } }) }
            return 'PUBLISH_NOW'
        } })
        await expect(sydChatAgentAdministration(log).publish({ ...actor, projectId, id: agent.id })).rejects.toMatchObject({ error: { code: 'VALIDATION', params: { message: expect.stringContaining('changed while') } } })
        const saved = await connection.getRepository(SydChatManagedAgentEntity).findOneByOrFail({ id: agent.id, projectId })
        expect(saved.published).toBeNull()
        expect(saved.draft.instructions).toBe('Concurrent edit')
        boundary.mockRestore()
    })

    it.each(['before review', 'after review'])('blocks approval-required publishing when a consuming flow appears %s', async (when) => {
        const { connection, actor } = await context()
        const projectId = apId()
        await connection.getRepository(project).save({ id: projectId, platformId: actor.platformId, ownerId: actor.userId })
        const draft = AgentConfig.parse({ instructions: 'Reviewed brief', provider: null, providerConfigId: null, modelName: null })
        const agent = await connection.getRepository(SydChatManagedAgentEntity).save({ id: apId(), projectId, ownerId: actor.userId, externalId: apId(), displayName: 'Researcher', description: null, icon: AgentIcon.SPARKLES, color: ColorName.PURPLE, visibility: AgentVisibility.PROJECT, sharedWithUserIds: [], folderId: null, draft, published: null })
        const flowId = apId(); const versionId = apId()
        const insertConsumer = async () => {
            await connection.getRepository(flow).save({ id: flowId, projectId, publishedVersionId: versionId })
            await connection.getRepository(version).save({ id: versionId, flowId, displayName: 'Approved workflow', agentIds: [agent.externalId] })
        }
        if (when === 'before review') await insertConsumer()
        const hooks = publishHooksFactory.get(log)
        let checks = 0
        const boundary = vi.spyOn(publishHooksFactory, 'get').mockReturnValue({ ...hooks, routePublish: async () => {
            if (++checks === 2 && when === 'after review') await insertConsumer()
            return 'NEEDS_APPROVAL'
        } })
        await expect(sydChatAgentAdministration(log).publish({ ...actor, projectId, id: agent.id })).rejects.toMatchObject({ error: { code: 'VALIDATION', params: { message: expect.stringContaining('approved consuming flow') } } })
        expect((await connection.getRepository(SydChatManagedAgentEntity).findOneByOrFail({ id: agent.id, projectId })).published).toBeNull()
        expect(await sydChatAgentAdministration(log).publishedFlowsUsing({ agent, projectId, userId: actor.userId })).toMatchObject({ total: 1, names: ['Approved workflow'] })
        boundary.mockRestore()
    })

})
