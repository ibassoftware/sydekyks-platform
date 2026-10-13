import { AIProviderName, apId } from '@activepieces/core-utils'
import { AgentConfig, AgentConversationStatus, AgentIcon, AgentRunSource, AgentVisibility, ChatPersonalizationScope, ChatPersonalizationStatus, ColorName, Flow, FlowVersion, PersonalizationUseCase, PersistedAgentMessage, PersistedAgentPartType, PersistedAgentRole } from '@activepieces/shared'
import Fastify from 'fastify'
import nodemailer from 'nodemailer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../../../../src/app/database'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { publishHooksFactory } from '../../../../src/app/flows/flow/flow-publish-hooks'
import { system } from '../../../../src/app/helper/system/system'
import { sydApprovalGate } from '../../../../src/app/syd/copilot/approval-gate'
import { sydCopilotContext } from '../../../../src/app/syd/copilot/copilot-context'
import { sydConversationService } from '../../../../src/app/syd/copilot/conversation-service'
import { SydConversationEntity } from '../../../../src/app/syd/copilot/models/conversation.entity'
import { sydPersonalizationResearch } from '../../../../src/app/syd/copilot/personalization/personalization-research'
import { sydPersonalizationService } from '../../../../src/app/syd/copilot/personalization/personalization-service'
import { sydPersonalizationStore } from '../../../../src/app/syd/copilot/personalization/personalization-store'
import { sydPersonalizationView } from '../../../../src/app/syd/copilot/personalization/personalization-view'
import { sydConversationRpc } from '../../../../src/app/syd/copilot/rpc/conversation-rpc'
import { sydEmailRpc } from '../../../../src/app/syd/copilot/rpc/email-rpc'
import { sydRunOperations } from '../../../../src/app/syd/copilot/rpc/run-operations'
import { sydToolExecutionRpc } from '../../../../src/app/syd/copilot/rpc/tool-execution-rpc'
import { sydChatAgentAdministration } from '../../../../src/app/syd/copilot/tools/chat-agent-administration'
import { sydChatAgentTools } from '../../../../src/app/syd/copilot/tools/chat-agent-tools'
import { sydToolUsage } from '../../../../src/app/syd/copilot/tool-usage'
import { createMockFlow, createMockFlowVersion, createMockProject, mockAndSaveAIProvider, mockAndSaveBasicSetup } from '../../../helpers/mocks'

const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: 'test' }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }))
const log = Fastify().log
const messages: PersistedAgentMessage[] = [{ role: PersistedAgentRole.USER, parts: [{ type: PersistedAgentPartType.TEXT, text: 'Hello' }] }, { role: PersistedAgentRole.ASSISTANT, parts: [{ type: PersistedAgentPartType.TEXT, text: 'Done' }] }]
const profile = { companyName: 'Syd\u0000', displayName: 'Syd', website: 'https://syd.example', description: 'Work\u0000 together', industry: 'Software' }
const useCases: PersonalizationUseCase[] = [{ id: 'one', title: 'Research', prompt: 'Research\u0000 prospects', imageId: 'write-reports' }]
beforeAll(async () => { await initializeDatabase({ runMigrations: false }) })
beforeEach(() => { vi.spyOn(sydPersonalizationView, 'emitProgress').mockImplementation(() => undefined) })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); sendMail.mockReset().mockResolvedValue({ messageId: 'test' }) })
afterAll(async () => { await redisConnections.destroy(); await databaseConnection().destroy() })
async function context() { const data = await mockAndSaveBasicSetup(); return { platformId: data.mockPlatform.id, userId: data.mockOwner.id, projectId: data.mockProject.id } }
async function conversation() { const actor = await context(); const row = await sydConversationService(log).createConversation({ ...actor, request: { projectId: actor.projectId } }); return { actor, row } }
function researchBoundary() { vi.spyOn(sydPersonalizationResearch, 'guardsAllowResearch').mockResolvedValue(true); return vi.spyOn(sydPersonalizationResearch, 'enqueueResearchJob').mockResolvedValue(undefined) }
async function writeCompany(actor: { platformId: string }, patch: Parameters<typeof sydPersonalizationStore.writeCompanyRow>[0]['patch']) { await sydPersonalizationStore.writeCompanyRow({ platformId: actor.platformId, existing: null, patch }) }

const personalize = sydPersonalizationService(log)
describe('Syd personalization lifecycle', () => {
    it('starts company research, normalizes input, claims once and fences superseded results', async () => {
        const actor = await context(); const queued = researchBoundary()
        const view = await personalize.upsert({ ...actor, website: 'https://syd.example/path', role: 'vp of sales', personalize: true })
        expect(view.status).toBe(ChatPersonalizationStatus.PENDING)
        const company = await sydPersonalizationStore.findRow({ ...actor, userId: null })
        expect(company?.domain).toBe('syd.example')
        expect(queued).toHaveBeenCalledTimes(1)
        const researchToken = company?.researchToken ?? null
        expect(await sydPersonalizationResearch.claimForResearch({ ...actor, scope: 'company', researchToken })).toBe(true)
        expect(await sydPersonalizationResearch.claimForResearch({ ...actor, scope: 'company', researchToken })).toBe(false)
        await personalize.saveResult({ ...actor, scope: 'company', researchToken: 'superseded', status: 'READY', profile, useCases })
        expect((await sydPersonalizationStore.findRow({ ...actor, userId: null }))?.status).toBe(ChatPersonalizationStatus.RESEARCHING)
        await personalize.saveResult({ ...actor, scope: 'company', researchToken, status: 'READY', profile, useCases })
        expect((await personalize.getEffectiveView(actor)).personalStatus).toBe(ChatPersonalizationStatus.READY)
        expect((await personalize.getIdentityEnrichment(actor))?.company?.name).toBe('Syd')
        expect(JSON.stringify(await sydPersonalizationStore.findRow(actor))).not.toContain('\\u0000')
    })
    it('prefers ready user data, exposes company input, and skips only the personal view', async () => {
        const actor = await context()
        await writeCompany(actor, { status: ChatPersonalizationStatus.READY, domain: 'company.example', profile: { ...profile, companyName: 'Company' }, useCases })
        await sydPersonalizationStore.writeUserRow({ ...actor, patch: { status: ChatPersonalizationStatus.READY, role: 'CFO', profile: { ...profile, companyName: 'Personal' }, useCases } })
        const view = await personalize.getEffectiveView(actor)
        expect(view.scope).toBe(ChatPersonalizationScope.USER)
        expect(view.companyInput).toBe('company.example')
        expect(view.profile?.companyName).toBe('Personal')
        const skipped = await personalize.upsert({ ...actor, personalize: false })
        expect(skipped.personalStatus).toBe(ChatPersonalizationStatus.SKIPPED)
        expect(skipped.profile?.companyName).toBe('Company')
    })
    it('preserves unchanged ready results and avoids duplicate research on role edits', async () => {
        const actor = await context(); const queue = researchBoundary()
        await writeCompany(actor, { status: ChatPersonalizationStatus.READY, domain: 'syd.example', profile, useCases })
        await sydPersonalizationStore.writeUserRow({ ...actor, patch: { status: ChatPersonalizationStatus.READY, role: 'CFO', profile, useCases } })
        await personalize.upsert({ ...actor, website: 'syd.example', role: 'cto', personalize: true })
        expect(queue).not.toHaveBeenCalled()
        expect((await sydPersonalizationStore.findRow(actor))?.role).toBe('CTO')
    })
    it('rejects malformed ready output and does not overwrite another user research token', async () => {
        const actor = await context(); researchBoundary()
        await writeCompany(actor, { status: ChatPersonalizationStatus.RESEARCHING, researchToken: 'company-token' })
        await sydPersonalizationStore.writeUserRow({ ...actor, patch: { status: ChatPersonalizationStatus.PENDING, researchToken: 'personal-token' } })
        await personalize.saveResult({ ...actor, scope: 'company', researchToken: 'company-token', status: 'READY', profile, useCases })
        expect((await sydPersonalizationStore.findRow(actor))?.researchToken).toBe('personal-token')
        await personalize.saveResult({ ...actor, scope: 'user', researchToken: 'personal-token', status: 'READY', profile: null, useCases: [] })
        expect((await sydPersonalizationStore.findRow(actor))?.status).toBe(ChatPersonalizationStatus.FAILED)
    })
    it('touches progress only for the current claimed token', async () => {
        const actor = await context(); const emitted = vi.spyOn(sydPersonalizationView, 'emitProgress').mockImplementation(() => undefined)
        await writeCompany(actor, { status: ChatPersonalizationStatus.RESEARCHING, researchToken: 'current' })
        await personalize.sendProgress({ ...actor, scope: 'company', researchToken: 'old', phase: 'research', message: 'Old' })
        expect(emitted).not.toHaveBeenCalled()
        await personalize.sendProgress({ ...actor, scope: 'company', researchToken: 'current', phase: 'research', message: 'New' })
        expect(emitted).toHaveBeenCalledOnce()
    })
    it('recovers stale research once with compare-and-swap and retains actor scope', async () => {
        const actor = await context(); const queue = researchBoundary()
        await writeCompany(actor, { status: ChatPersonalizationStatus.RESEARCHING, researchToken: 'old', domain: 'syd.example' })
        await sydPersonalizationStore.personalizationRepo().createQueryBuilder().update().set({ updated: new Date(Date.now() - 180000).toISOString() }).where({ platformId: actor.platformId }).execute()
        const row = await sydPersonalizationStore.findRow({ ...actor, userId: null })
        await sydPersonalizationResearch.recoverIfStale({ ...actor, row, scope: ChatPersonalizationScope.COMPANY, log })
        await sydPersonalizationResearch.recoverIfStale({ ...actor, row, scope: ChatPersonalizationScope.COMPANY, log })
        expect(queue).not.toHaveBeenCalled()
        expect((await sydPersonalizationStore.findRow({ ...actor, userId: null }))?.status).toBe(ChatPersonalizationStatus.FAILED)
        expect((await sydPersonalizationStore.findRow({ ...actor, userId: null }))?.researchToken).not.toBe('old')
    })
    it('stores prefill without company creation and suppresses it after configuration', async () => {
        const actor = await context()
        await personalize.savePrefill({ ...actor, role: 'CTO', confidence: 'high' })
        expect(await sydPersonalizationResearch.readPrefill({ ...actor, log })).toEqual({ role: 'CTO', confidence: 'high' })
        expect(await sydPersonalizationStore.findRow({ ...actor, userId: null })).toBeNull()
        await writeCompany(actor, { status: ChatPersonalizationStatus.READY })
        await personalize.savePrefill({ ...actor, role: 'CFO', confidence: 'low' })
        expect((await sydPersonalizationResearch.readPrefill({ ...actor, log }))?.role).toBe('CTO')
    })
    it('starts missing user research from company context and skips when admission is denied', async () => {
        const actor = await context(); const queued = researchBoundary()
        await writeCompany(actor, { status: ChatPersonalizationStatus.READY, domain: 'syd.example', profile, useCases })
        await personalize.upsert({ ...actor, role: 'CTO', personalize: true })
        expect((await sydPersonalizationStore.findRow(actor))?.status).toBe(ChatPersonalizationStatus.PENDING)
        expect(queued).toHaveBeenCalledWith(expect.objectContaining({ scope: 'user', role: 'CTO' }))
        const denied = await context()
        await writeCompany(denied, { status: ChatPersonalizationStatus.READY, domain: 'syd.example', profile, useCases })
        vi.mocked(sydPersonalizationResearch.guardsAllowResearch).mockResolvedValue(false)
        await personalize.upsert({ ...denied, personalize: true })
        expect((await sydPersonalizationStore.findRow(denied))?.status).toBe(ChatPersonalizationStatus.SKIPPED)
    })

    it('returns claimed worker credentials and rejects duplicate claims', async () => {
        const actor = await context()
        await mockAndSaveAIProvider({ platformId: actor.platformId, provider: AIProviderName.OPENAI, config: {}, enabledForChat: true })
        await writeCompany(actor, { status: ChatPersonalizationStatus.PENDING, researchToken: 'worker', domain: 'syd.example' })
        const input = { ...actor, scope: 'company' as const, researchToken: 'worker' }
        expect(await personalize.getConfigForWorker(input)).toMatchObject({ claimed: true, website: 'syd.example', credentials: { provider: AIProviderName.OPENAI } })
        expect(await personalize.getConfigForWorker(input)).toEqual({ claimed: false })
        expect((await personalize.getPrefillConfigForWorker(actor)).email).toContain('@')
    })
})

describe('Syd worker persistence and RPC', () => {
    it('fences progress, heartbeat and final saves and never shrinks model history', async () => {
        const { actor, row } = await conversation(); const rpc = sydConversationRpc(log)
        await sydCopilotContext.claimConversationForRun({ ...actor, conversationId: row.id, runId: 'active' })
        await sydCopilotContext.acquireStreamingLock({ ...actor, conversationId: row.id, runId: 'active' })
        const repo = databaseConnection().getRepository(SydConversationEntity)
        await repo.update({ id: row.id, platformId: actor.platformId }, { messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Done' }] })
        await rpc.updateAgentProgress({ conversationId: row.id, runId: 'old', uiMessages: messages })
        expect((await sydConversationService(log).getConversationOrThrow({ ...actor, id: row.id })).uiMessages).toBeNull()
        await rpc.saveAgentMessages({ conversationId: row.id, runId: 'old', messages: [{ role: 'user', content: 'Old' }], uiMessages: messages })
        expect((await sydConversationService(log).getConversationOrThrow({ ...actor, id: row.id })).status).toBe(AgentConversationStatus.STREAMING)
        await rpc.heartbeatAgentConversation({ conversationId: row.id, runId: 'active' })
        await rpc.saveAgentMessages({ conversationId: row.id, runId: 'active', messages: [{ role: 'user', content: 'Short' }], uiMessages: messages })
        expect((await sydConversationService(log).getConversationOrThrow({ ...actor, id: row.id })).messages).toHaveLength(2)
    })
    it('resolves a saved turn despite a billing failure and sanitizes recovered failure text', async () => {
        const { actor, row } = await conversation(); const charge = vi.spyOn(sydToolUsage, 'chargeForLatestTurn').mockRejectedValue(new Error('Billing unavailable'))
        const rpc = sydConversationRpc(log)
        await expect(rpc.saveAgentMessages({ conversationId: row.id, messages: [{ role: 'user', content: 'Hello' }], uiMessages: messages })).resolves.toBeUndefined()
        await vi.waitFor(() => expect(charge).toHaveBeenCalled())
        expect((await sydConversationService(log).getConversationOrThrow({ ...actor, id: row.id })).status).toBe(AgentConversationStatus.IDLE)
        await rpc.saveAgentMessages({ conversationId: row.id, messages: [], uiMessages: [], failure: { message: 'Failed\u0000 safely', userMessage: 'Help\u0000' } })
        const stored = await sydConversationService(log).getConversationOrThrow({ ...actor, id: row.id })
        expect(stored.status).toBe(AgentConversationStatus.ERROR)
        expect(JSON.stringify(stored.uiMessages)).toContain('Failed safely')
    })
    it('keeps artifacts scoped to the conversation and accessible project', async () => {
        const { actor, row } = await conversation(); const rpc = sydConversationRpc(log)
        const file = await rpc.saveAgentFile({ platformId: actor.platformId, projectId: actor.projectId, conversationId: row.id, fileName: 'report.txt', mediaType: 'text/plain', data: Buffer.from('Syd report') })
        expect((await rpc.readAgentFile({ ...actor, conversationId: row.id, fileId: file.fileId })).data.toString()).toBe('Syd report')
        const other = await sydConversationService(log).createConversation({ ...actor, request: { projectId: actor.projectId } })
        await expect(rpc.readAgentFile({ ...actor, conversationId: other.id, fileId: file.fileId })).rejects.toThrow()
    })
    it('switches only to accessible projects and denies missing provider scope', async () => {
        const { actor, row } = await conversation(); const other = await context()
        await expect(sydConversationRpc(log).updateProjectContext({ conversationId: row.id, projectId: other.projectId })).rejects.toThrow()
        expect(() => sydCopilotContext.runScopeOrThrow({ projectId: null })).toThrow()
        expect(sydCopilotContext.selectRunProject({ projects: [], conversationProjectId: null })).toBeNull()
    })
    it('keeps a pinned project-only AI key from crossing project or platform scopes', async () => {
        const { actor } = await conversation()
        const other = createMockProject({ platformId: actor.platformId, ownerId: actor.userId })
        await databaseConnection().getRepository('project').save(other)
        const key = await mockAndSaveAIProvider({ platformId: actor.platformId, provider: AIProviderName.OPENAI, config: {}, enabledForChat: true, projectScope: 'selected', projectIds: [actor.projectId] })
        const common = { platformId: actor.platformId, provider: AIProviderName.OPENAI, providerConfigId: key.id, fromProjectId: actor.projectId, log }
        await expect(sydCopilotContext.assertProjectSwitchKeepsKey({ ...common, toProjectId: other.id })).rejects.toThrow()
        await expect(sydCopilotContext.assertProjectSwitchKeepsKey({ ...common, toProjectId: null })).rejects.toThrow()
        await expect(sydCopilotContext.assertProjectSwitchKeepsKey({ ...common, toProjectId: actor.projectId })).resolves.toBeUndefined()
        await expect(sydCopilotContext.resolveRunProvider({ ...common, scope: { type: 'project', projectId: actor.projectId } })).resolves.toMatchObject({ configId: key.id })
        await expect(sydCopilotContext.resolveRunProvider({ ...common, scope: { type: 'project', projectId: other.id } })).rejects.toThrow()
    })

    it('keeps internal branches usable before streaming while rejecting non-CHAT tools', async () => {
        const { actor, row } = await conversation(); const rpc = sydToolExecutionRpc(log)
        const input = { ...actor, conversationId: row.id, source: AgentRunSource.CHAT }
        await rpc.executeAgentTool({ ...input, toolName: '__store_selected_connection', toolInput: { pieceName: 'slack', connectionExternalId: 'account', projectId: actor.projectId } })
        expect((await rpc.executeAgentTool({ ...input, toolName: '__get_selected_connection', toolInput: { pieceName: 'slack' } })).result).toMatchObject({ externalId: 'account' })
        expect((await rpc.executeAgentTool({ ...input, toolName: '__flow_write_check', toolInput: {} })).result).toEqual({ hasWrites: false })
        await expect(rpc.executeAgentTool({ ...input, source: AgentRunSource.AGENT, toolName: '__cancel_check', toolInput: {} })).rejects.toThrow()
        await sydRunOperations.markTurnAsHavingRead({ conversationId: row.id, runId: 'run' })
        await expect(rpc.executeAgentTool({ ...input, runId: 'run', toolName: 'ap_update_agent', toolInput: {} })).rejects.toThrow()
        expect(sydRunOperations.outcomeOfToolResult({ success: false })).toBe('FAILED')
    })
})

describe('Syd conditional agent administration', () => {
    const service = sydChatAgentAdministration(log)
    async function agent() {
        const actor = await context()
        const draft = AgentConfig.parse({ instructions: 'Research prospects', provider: null, providerConfigId: null, modelName: null })
        const row = await service.create({ ...actor, ownerId: actor.userId, request: { projectId: actor.projectId, displayName: 'Researcher', description: null, folderId: null, icon: AgentIcon.SPARKLES, color: ColorName.PURPLE, draft } })
        return { actor, row }
    }
    it('creates, searches, lists lightweight summaries and scopes reads to a project', async () => {
        const { actor, row } = await agent(); const other = await context()
        expect(row).toMatchObject({ ownerId: actor.userId, published: null, visibility: AgentVisibility.PROJECT })
        expect((await service.list({ ...actor, search: 'research', limit: 10 })).data[0]).toMatchObject({ id: row.id, isPublished: false, toolCount: 0 })
        expect((await service.list({ ...actor, search: 'missing' })).data).toEqual([])
        await expect(service.getOneOrThrow({ id: row.id, projectId: other.projectId, userId: actor.userId })).rejects.toThrow()
    })
    it('updates metadata and keeps published instructions separate from subsequent draft edits', async () => {
        const { actor, row } = await agent()
        const hooks = publishHooksFactory.get(log); vi.spyOn(publishHooksFactory, 'get').mockReturnValue({ ...hooks, routePublish: async () => 'PUBLISH_NOW' })
        await service.update({ ...actor, id: row.id, request: { visibility: AgentVisibility.RESTRICTED, icon: AgentIcon.BOT, displayName: 'Private' } })
        const published = await service.publish({ ...actor, id: row.id })
        expect(published.published?.instructions).toBe('Research prospects')
        expect(published.icon).toBe(AgentIcon.BOT)
        expect(published.visibility).toBe(AgentVisibility.RESTRICTED)
        const changed = await service.update({ ...actor, id: row.id, request: { draft: { ...row.draft, instructions: 'Changed\u0000 brief' } } })
        expect(changed.draft.instructions).toBe('Changed brief')
        expect(changed.published?.instructions).toBe('Research prospects')
        expect(await service.editDraftTools({ ...actor, id: row.id, edit: () => null })).toBeNull()
    })
    it('publishes through the CHAT tool flag and retains a staged draft when an approved flow blocks a later publish', async () => {
        const { actor, row } = await agent()
        const hooks = publishHooksFactory.get(log)
        const publish = vi.spyOn(publishHooksFactory, 'get').mockReturnValue({ ...hooks, routePublish: async () => 'PUBLISH_NOW' })
        expect(await sydChatAgentTools.afterDraftChange({ ...actor, agent: row, publish: true, log })).toMatchObject({ published: true })
        const live = await service.getOneOrThrow({ ...actor, id: row.id })
        const flow = createMockFlow({ projectId: actor.projectId })
        const version = createMockFlowVersion({ flowId: flow.id, agentIds: [row.externalId] })
        await databaseConnection().getRepository<Flow>('flow').save(flow)
        await databaseConnection().getRepository<FlowVersion>('flow_version').save(version)
        await databaseConnection().getRepository<Flow>('flow').save({ id: flow.id, publishedVersionId: version.id })
        publish.mockReturnValue({ ...hooks, routePublish: async () => 'NEEDS_APPROVAL' })
        expect(await sydChatAgentTools.updateAgentFromChat({ ...actor, agent: live, log, toolInput: { instructions: 'Staged change', publish: true } })).toMatchObject({ published: false, note: expect.stringContaining('draft is saved') })
        const saved = await service.getOneOrThrow({ ...actor, id: row.id })
        expect(saved.draft.instructions).toBe('Staged change')
        expect(saved.published?.instructions).toBe('Research prospects')
    })

    it('refuses empty/coherently unpinned drafts and rejects sharing outside project access', async () => {
        const { actor, row } = await agent()
        await service.update({ ...actor, id: row.id, request: { draft: { ...row.draft, instructions: '' } } })
        await expect(service.publish({ ...actor, id: row.id })).rejects.toThrow()
        await expect(service.update({ ...actor, id: row.id, request: { visibility: AgentVisibility.RESTRICTED, sharedWithUserIds: [apId()] } })).rejects.toThrow()
    })
    it('executes the five-tool CHAT dispatcher and refuses unsupported project selection', async () => {
        const { actor, row } = await conversation()
        vi.spyOn(sydCopilotContext, 'agentsSurfaceAvailable').mockResolvedValue(true)
        const projects = await sydCopilotContext.getUserProjects({ ...actor, log })
        const input = { ...actor, projects, conversationId: row.id, log }
        const created = await sydChatAgentTools.execute({ ...input, toolName: 'ap_create_agent', toolInput: { displayName: 'Writer', instructions: 'Write reports' } })
        expect(created).toHaveProperty('agentId')
        const list = await sydChatAgentTools.execute({ ...input, toolName: 'ap_list_agents', toolInput: {} })
        expect(Array.isArray(list)).toBe(true)
        expect(await sydChatAgentTools.execute({ ...input, projects: [], toolName: 'ap_create_agent', toolInput: {} })).toHaveProperty('error')
    })
})

describe('Syd email transport and approval', () => {
    function smtp() { for (const [key, value] of Object.entries({ AP_SMTP_HOST: 'test', AP_SMTP_PORT: '2525', AP_SMTP_USERNAME: 'test', AP_SMTP_PASSWORD: 'test', AP_SMTP_SENDER_EMAIL: 'syd@example.com' })) vi.stubEnv(key, value) }
    it('refuses unconfigured email without opening a transport', async () => {
        const { actor, row } = await conversation(); vi.spyOn(system, 'get').mockReturnValue(undefined)
        expect((await sydEmailRpc(log).sendAgentEmail({ ...actor, conversationId: row.id, to: ['user@example.com'], subject: 'Hello', body: 'Hi' })).sent).toBe(false)
        expect(nodemailer.createTransport).not.toHaveBeenCalled()
    })
    it('requires exact external content approval, then sends escaped branded email', async () => {
        const { actor, row } = await conversation(); smtp()
        const input = { ...actor, conversationId: row.id, to: [' Outside@example.com ', 'outside@example.com'], subject: 'Report', body: '<b>Report</b>' }
        expect((await sydEmailRpc(log).sendAgentEmail(input)).sent).toBe(false)
        const gateId = apId()
        await sydApprovalGate.storePendingGate({ conversationId: row.id, gate: { gateId, toolName: 'ap_send_email', displayName: 'Email', toolInput: { to: ['outside@example.com'], subject: input.subject, body: input.body } } })
        await sydApprovalGate.resolveGate({ gateId, approved: true })
        expect((await sydEmailRpc(log).sendAgentEmail({ ...input, gateId, body: 'Changed' })).sent).toBe(false)
        expect((await sydEmailRpc(log).sendAgentEmail({ ...input, gateId })).sent).toBe(true)
        expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ['outside@example.com'], html: expect.stringContaining('&lt;b&gt;Report&lt;/b&gt;') }))
    })
    it('rejects invalid recipients, stale turns and transport failures visibly', async () => {
        const { actor, row } = await conversation(); smtp()
        const input = { ...actor, conversationId: row.id, to: ['bad'], subject: 'Report', body: 'Body' }
        expect((await sydEmailRpc(log).sendAgentEmail(input)).blockedRecipients).toEqual(['bad'])
        expect((await sydEmailRpc(log).sendAgentEmail({ ...input, runId: 'stale' })).message).toContain('no longer active')
        const fixture = await mockAndSaveBasicSetup()
        const owned = await sydConversationService(log).createConversation({ platformId: fixture.mockPlatform.id, userId: fixture.mockOwner.id, request: {} })
        sendMail.mockRejectedValueOnce(new Error('SMTP unavailable'))
        expect((await sydEmailRpc(log).sendAgentEmail({ platformId: fixture.mockPlatform.id, userId: fixture.mockOwner.id, conversationId: owned.id, to: [fixture.mockUserIdentity.email], subject: 'Report', body: 'Body' })).sent).toBe(false)
    })
})
