import { apId } from '@activepieces/core-utils'
import { AgentConversationStatus, AgentRunSource, PersistedAgentMessage, PersistedAgentPartType, PersistedAgentRole } from '@activepieces/shared'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../../../../src/app/database'
import { backgroundMigrationRunner } from '../../../../src/app/database/background-migration-runner'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { getMigrations } from '../../../../src/app/database/postgres-connection'
import { sydApprovalGate } from '../../../../src/app/syd/copilot/approval-gate'
import { sydConversationService } from '../../../../src/app/syd/copilot/conversation-service'
import { sydConversationUsage } from '../../../../src/app/syd/copilot/conversation-usage'
import { sydCopilotContext } from '../../../../src/app/syd/copilot/copilot-context'
import { SydConversationEntity } from '../../../../src/app/syd/copilot/models/conversation.entity'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'

const log = Fastify().log
const service = sydConversationService(log)

beforeAll(async () => {
    await initializeDatabase({ runMigrations: false }) 
})
afterAll(async () => {
    await databaseConnection().destroy() 
})

async function context() {
    const fixture = await mockAndSaveBasicSetup()
    return { platformId: fixture.mockPlatform.id, userId: fixture.mockOwner.id, projectId: fixture.mockProject.id }
}

describe('Syd CHAT persistence', () => {
    it('registers owned CHAT storage and the release migrations without schema drift', async () => {
        const ds = databaseConnection()
        const runner = ds.createQueryRunner()
        expect(getMigrations().map((Migration) => new Migration().name)).toEqual([
            'SydekyksInitialSchema1880000000000', 'SydekyksUpstream1031881000000000', 'SydekyksUpstreamOctober211882000000000',
            'SydekyksHostingLedger1882000000000', 'SydekyksHostingDispatch1883000000000',
            'SydekyksHostingSegments1884000000000', 'SydekyksHostingModelCalls1885000000000',
            'SydekyksHostingStripe1886000000000', 'SydekyksHostingAccess1887000000000',
            'SydekyksLearning1888000000000', 'SydekyksTrainingGrants1889000000000',
            'SydekyksManagedPricing1890000000000', 'SydekyksClientAiAllowance1892000000000',
            'SydekyksPricingValidation1893000000000',
            'SydekyksPartnerAdmin1894000000000',
            'SydekyksPartnerSetup1895000000000',
            'SydekyksTenantMembers1896000000000',
            'SydekyksCourseAccess1897000000000',
            'SydekyksPlatformTrainers1898000000000',
            'SydekyksAssessmentAccess1899000000000',
            'SydekyksRecovery1900000000000',
            'SydekyksStorageLimits1901000000000',
        ])
        for (const table of ['syd_conversation', 'syd_user_memory', 'syd_personalization']) expect(await runner.hasTable(table)).toBe(true)
        expect(await runner.hasColumn('platform_model_tier', 'isFast')).toBe(true)
        expect(await runner.hasColumn('platform_configuration', 'aiSpecificModelsVisible')).toBe(true)
        await backgroundMigrationRunner.run({ dataSource: ds, log })
        // Hosted migrations also install composite constraints absent from ORM
        // metadata. This regression protects the CHAT-owned storage schema.
        const ownedTables = ['syd_conversation', 'syd_user_memory', 'syd_personalization', 'syd_chat_managed_agent', 'syd_agent_conversation', 'platform_model_tier', 'platform_configuration']
        const ownedObjects = [...ownedTables, ...(await runner.getTables(ownedTables)).flatMap(table => table.indices.map(index => index.name))]
        const changes = (await ds.driver.createSchemaBuilder().log()).upQueries
        expect(changes.filter(change => ownedObjects.some(name => change.query.includes(`"${name}"`)))).toEqual([])
        await runner.release()
    })

    it('creates CHAT defaults and rejects saved-agent, builder and evaluation requests', async () => {
        const actor = await context()
        const row = await service.createConversation({ ...actor, request: { title: 'Work', modelName: 'fast', projectId: actor.projectId } })
        expect(row).toMatchObject({ ...actor, source: AgentRunSource.CHAT, status: AgentConversationStatus.IDLE, title: 'Work', modelName: 'fast', agentId: null, flowRunId: null, messages: [], uiMessages: null })
        for (const request of [{ agentId: apId() }, { builder: true }]) await expect(service.createConversation({ ...actor, request })).rejects.toThrow()
        await expect(service.createConversation({ ...actor, id: 'evalconv-invalid', request: {} })).rejects.toThrow()
    })

    it('denies another platform project and conversation access', async () => {
        const owner = await context()
        const stranger = await context()
        const row = await service.createConversation({ ...owner, request: {} })
        await expect(service.createConversation({ ...owner, request: { projectId: stranger.projectId } })).rejects.toThrow()
        await expect(service.getConversationOrThrow({ ...stranger, id: row.id })).rejects.toThrow()
        await expect(service.updateConversation({ ...stranger, id: row.id, request: { title: 'Taken' } })).rejects.toThrow()
        await expect(service.deleteConversation({ ...stranger, id: row.id })).rejects.toThrow()
        expect((await service.listConversations({ ...stranger, limit: 10 })).data).toEqual([])
    })

    it('paginates in both directions without mixing owners', async () => {
        const actor = await context()
        for (let index = 0; index < 5; index++) await service.createConversation({ ...actor, request: { title: String(index) } })
        const first = await service.listConversations({ ...actor, limit: 2 })
        const second = await service.listConversations({ ...actor, limit: 2, cursor: first.next ?? undefined })
        const previous = await service.listConversations({ ...actor, limit: 2, cursor: second.previous ?? undefined })
        expect(first.data).toHaveLength(2)
        expect(first.data[0]).not.toHaveProperty('messages')
        expect(first.data[0]).not.toHaveProperty('uiMessages')
        expect(second.data).toHaveLength(2)
        expect(new Set([...first.data, ...second.data].map((row) => row.id)).size).toBe(4)
        expect(previous.data.map((row) => row.id)).toEqual(first.data.map((row) => row.id))
    })

    it('updates nullable metadata while preserving messages', async () => {
        const actor = await context()
        const row = await service.createConversation({ ...actor, request: { title: 'Old' } })
        await service.updateConversation({ ...actor, id: row.id, request: { title: null, modelName: 'smart' } })
        expect(await service.getConversationOrThrow({ ...actor, id: row.id })).toMatchObject({ title: null, modelName: 'smart', messages: [] })
    })

    it('recovers only stale STREAMING rows', async () => {
        const actor = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        const repo = databaseConnection().getRepository(SydConversationEntity)
        await repo.update({ id: row.id, platformId: actor.platformId }, { status: AgentConversationStatus.STREAMING, updated: new Date(Date.now() - 100_000).toISOString() })
        expect((await service.getConversationOrThrow({ ...actor, id: row.id })).status).toBe(AgentConversationStatus.IDLE)
        await repo.update({ id: row.id, platformId: actor.platformId }, { status: AgentConversationStatus.STREAMING })
        expect((await service.getConversationOrThrow({ ...actor, id: row.id })).status).toBe(AgentConversationStatus.STREAMING)
    })

    it('fences old runs after a newer run claims the conversation', async () => {
        const actor = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        const run = { ...actor, conversationId: row.id, runId: apId() }
        await sydCopilotContext.claimConversationForRun(run)
        expect(await sydCopilotContext.acquireStreamingLock(run)).toBe('acquired')
        expect(await sydCopilotContext.acquireStreamingLock(run)).toBe('busy')
        const newer = { ...run, runId: apId() }
        expect(await sydCopilotContext.claimConversationForRun(newer)).toMatchObject({ preemptedRunId: run.runId, wasStreaming: true })
        expect(await sydCopilotContext.acquireStreamingLock(run)).toBe('superseded')
        expect(await sydCopilotContext.acquireStreamingLock(newer)).toBe('acquired')
        await expect(sydCopilotContext.claimConversationForRun({ ...run, userId: apId() })).rejects.toThrow()
    })

    it('patches only assistant feedback and preserves appended history', async () => {
        const actor = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        const repo = databaseConnection().getRepository(SydConversationEntity)
        const history: PersistedAgentMessage[] = [
            { role: PersistedAgentRole.USER, parts: [{ type: PersistedAgentPartType.TEXT, text: 'Hello' }] },
            { role: PersistedAgentRole.ASSISTANT, parts: [{ type: PersistedAgentPartType.TEXT, text: 'Welcome' }] },
        ]
        await repo.save({ id: row.id, platformId: actor.platformId, uiMessages: history })
        const feedback = { ...actor, id: row.id, messageIndex: 1, request: { rating: 'up', comment: '  Helpful  ' } }
        await service.setMessageFeedback({ ...feedback, request: { rating: 'up', comment: '  Helpful  ' } })
        const stored = await service.getConversationOrThrow({ ...actor, id: row.id })
        expect(stored.uiMessages?.[1].feedback).toEqual({ rating: 'up', comment: 'Helpful' })
        await repo.createQueryBuilder().update().set({ uiMessages: () => '"uiMessages" || :append::jsonb' }).where({ id: row.id, platformId: actor.platformId }).setParameter('append', JSON.stringify([{ role: PersistedAgentRole.USER, parts: [] }])).execute()
        await service.setMessageFeedback({ ...feedback, request: { rating: null } })
        expect((await service.getMessages({ ...actor, id: row.id })).data).toHaveLength(3)
        await expect(service.setMessageFeedback({ ...feedback, messageIndex: 0, request: { rating: 'down' } })).rejects.toThrow()
        await expect(service.setMessageFeedback({ ...feedback, messageIndex: -1, request: { rating: 'down' } })).rejects.toThrow()
    })

    it('rounds credit increments and reconstructs legacy history', async () => {
        const actor = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        await sydConversationUsage(log).addConversationCredits({ conversationId: row.id, credits: 0.4 })
        await sydConversationUsage(log).addConversationCredits({ conversationId: row.id, credits: 2.6 })
        await sydConversationUsage(log).addConversationCredits({ conversationId: row.id, credits: 1 })
        const repo = databaseConnection().getRepository(SydConversationEntity)
        await repo.update({ id: row.id, platformId: actor.platformId }, { messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Welcome' }] })
        expect((await service.getConversationOrThrow({ ...actor, id: row.id })).aiCredits).toBe(4)
        expect((await service.getMessages({ ...actor, id: row.id })).data).toEqual([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Welcome' }])
    })

    it('caps and merges memory without reviving a concurrently removed fact', async () => {
        const actor = await context()
        expect(await sydCopilotContext.getUserMemory(actor)).toEqual({ instructions: null, memories: [] })
        await sydCopilotContext.saveUserMemory({ ...actor, instructions: '  Be concise  ', memories: ['Alpha', 'Beta'] })
        await sydCopilotContext.saveUserMemory({ ...actor, memories: ['Alpha', 'New concurrent fact'] })
        const saved = await sydCopilotContext.saveUserMemory({ ...actor, memories: ['Alpha', 'Beta', 'Incoming'], baseMemories: ['Alpha', 'Beta'] })
        expect(saved).toEqual({ instructions: 'Be concise', memories: ['Alpha', 'Incoming', 'New concurrent fact'] })
        const capped = await sydCopilotContext.saveUserMemory({ ...actor, instructions: 'x'.repeat(5000), memories: Array.from({ length: 60 }, (_, index) => `${index} ${'y'.repeat(300)}`) })
        expect(capped.instructions).toHaveLength(4000)
        expect(capped.memories).toHaveLength(50)
        expect(capped.memories.every((memory) => memory.length === 280)).toBe(true)
    })

    it('cancels a streaming conversation before deletion', async () => {
        const actor = await context()
        const row = await service.createConversation({ ...actor, request: {} })
        await databaseConnection().getRepository(SydConversationEntity).update({ id: row.id, platformId: actor.platformId }, { status: AgentConversationStatus.STREAMING, activeRunId: 'run' })
        const cancel = vi.spyOn(sydApprovalGate, 'requestCancel').mockResolvedValue()
        const clear = vi.spyOn(sydApprovalGate, 'clearPendingGate').mockResolvedValue()
        await service.deleteConversation({ ...actor, id: row.id })
        expect(cancel).toHaveBeenCalledWith({ conversationId: row.id, runId: 'run' })
        expect(clear).toHaveBeenCalledWith({ conversationId: row.id })
        await expect(service.getConversationOrThrow({ ...actor, id: row.id })).rejects.toThrow()
        cancel.mockRestore()
        clear.mockRestore()
    })
})
