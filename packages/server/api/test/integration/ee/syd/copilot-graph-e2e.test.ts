import { spawn, ChildProcess } from 'node:child_process'
import { AIProviderName } from '@activepieces/core-utils'
import { Property } from '@activepieces/pieces-framework'
import { agentAiUtils, aiUtils } from '@activepieces/server-utils'
import { ApEdition, AgentConversation, AgentConversationStatus, Flow, FlowActionType, FlowRun, FlowRunStatus, FlowStatus, RunEnvironment, TriggerStrategy, TriggerTestStrategy, flowStructureUtil, PackageType, PieceType, StepLocationRelativeToParent } from '@activepieces/shared'
import { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { worker } from '../../../../../worker/src/lib/worker'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { flowRunService } from '../../../../src/app/flows/flow-run/flow-run-service'
import { flowService } from '../../../../src/app/flows/flow/flow.service'
import { pubsub } from '../../../../src/app/helper/pubsub'
import { billingProvider } from '../../../../src/app/platform/billing-provider'
import { sydCopilotContext } from '../../../../src/app/syd/copilot/copilot-context'
import { setupE2eEnvironment } from '../../../helpers/e2e-setup'
import { createMockPieceMetadata, mockAndSaveAIProvider } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'

vi.mock('../../../../src/app/platform/billing-and-telemetry', () => ({ trackBillingAndSendTelemetry: vi.fn().mockResolvedValue(undefined) }))

let app: FastifyInstance
let actor: TestContext
let web: ChildProcess | undefined
const browserPort = Number(process.env.SYD_GRAPH_UI_PORT ?? 4319)
const browserUrl = `http://127.0.0.1:${browserPort}`
let called: string[] = []
let modelFailure: Error | null = null

describe.skipIf(process.env.SYD_GRAPH_E2E !== 'true')('Syd CHAT graph user journey', () => {
    beforeAll(async () => {
        const env = await setupE2eEnvironment()
        app = env.app
        actor = await createTestContext(app, { plan: { chatEnabled: process.env.AP_EDITION !== ApEdition.COMMUNITY, agentsEnabled: false, aiProvidersEnabled: false } })
        await mockAndSaveAIProvider({ platformId: actor.platform.id, provider: AIProviderName.OPENAI, config: {}, enabledForChat: true })
        if (process.env.AP_EDITION !== ApEdition.COMMUNITY) {
            const base = billingProvider.get(app.log)
            vi.spyOn(billingProvider, 'get').mockReturnValue({ ...base, getCreditsAndAppSumoState: async () => ({ credits: { blocked: false, metered: false, usage: 0, limit: 100, remaining: 100, unlimited: false }, appSumo: { blocked: false, metered: false, usage: 0, limit: 0, remaining: 0, unlimited: true } }) })
        }
        vi.spyOn(agentAiUtils, 'affordableOutputTokens').mockResolvedValue(4000)
        vi.spyOn(sydCopilotContext, 'resolveImageModelId').mockResolvedValue(undefined)
        await databaseConnection().getRepository('piece_metadata').save(createMockPieceMetadata({ name: '@activepieces/piece-webhook', displayName: 'Webhook', version: '0.1.29', platformId: undefined, pieceType: PieceType.OFFICIAL, packageType: PackageType.REGISTRY, triggers: { catch_webhook: { name: 'catch_webhook', displayName: 'Catch Webhook', description: 'Receive test data', requireAuth: false, props: { authType: Property.StaticDropdown({ displayName: 'Authentication', required: true, defaultValue: 'none', options: { options: [{ label: 'None', value: 'none' }] } }) }, type: TriggerStrategy.WEBHOOK, sampleData: {}, testStrategy: TriggerTestStrategy.SIMULATION } } }))
        web = spawn(process.execPath, ['node_modules/.bin/vite', '--config', 'tools/syd/vite-graph.config.mts', '--mode', 'syd-e2e'], { env: { ...process.env, SYD_TEST_API_URL: env.apiUrl, SYD_TEST_UI_PORT: String(browserPort) }, stdio: 'pipe' })
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Test frontend did not start')), 60000)
            web?.stdout?.on('data', (data: Buffer) => { process.stdout.write(data); if (data.toString().includes('Local:')) { clearTimeout(timer); resolve() } })
            web?.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Test frontend exited ${code}`)) })
        })
        web.stderr?.on('data', (data: Buffer) => process.stderr.write(data))
        await vi.waitFor(async () => { const response = await app.inject({ url: '/api/v1/flags' }); expect(response.statusCode).toBe(200) })
        process.env.AP_FRONTEND_URL = browserUrl
        await worker.start({ apiUrl: env.apiUrl, socketUrl: { url: env.apiUrl, path: '/api/socket.io' }, workerToken: env.workerToken })
        vi.spyOn(aiUtils, 'createModel').mockReturnValue(graphModel())
    }, 120000)

    afterAll(async () => {
        await worker.stop()
        web?.kill('SIGTERM')
        await app?.close()
        await pubsub.close()
        await redisConnections.destroy()
        await databaseConnection().destroy()
        vi.restoreAllMocks()
    }, 30000)

    it('creates and edits a loop/router graph through authenticated CHAT and real MCP, tests both branches, publishes and executes a real webhook, and renders it in Chrome', async () => {
        if (process.env.AP_EDITION === ApEdition.COMMUNITY) {
            const platform = (await actor.get(`/v1/platforms/${actor.platform.id}`)).json()
            expect(platform.plan).toMatchObject({ aiProvidersEnabled: true, chatEnabled: true, agentsEnabled: false })
            expect((await actor.get(`/v1/agents?projectId=${actor.project.id}`)).statusCode).toBe(404)
        }
        const created = await actor.post('/v1/syd/copilot/conversations', { projectId: actor.project.id, title: 'Graph test' })
        expect(created.statusCode).toBe(201)
        const conversation = created.json<AgentConversation>()
        expect((await actor.post(`/v1/syd/copilot/conversations/${conversation.id}/messages`, { content: 'Build a webhook workflow: normalize an amount, loop over two items, route large totals to a high branch and small totals to a fallback, edit normalization to multiply by three, test both branches, and publish it.' })).statusCode).toBe(200)
        await vi.waitFor(async () => {
            if (modelFailure) throw modelFailure
            const saved = (await actor.get(`/v1/syd/copilot/conversations/${conversation.id}`)).json<AgentConversation>()
            expect(saved.status).toBe(AgentConversationStatus.IDLE)
            expect(JSON.stringify(saved.uiMessages)).toContain('Graph built and tested')
        }, { timeout: 170000, interval: 500 })
        expect(called).toContain('ap_test_flow')
        const flow = await databaseConnection().getRepository<Flow>('flow').findOneByOrFail({ projectId: actor.project.id })
        const populated = await flowService(app.log).getOnePopulatedOrThrow({ id: flow.id, projectId: actor.project.id })
        const steps = flowStructureUtil.getAllSteps(populated.version.trigger)
        expect(steps.map((step) => step.displayName)).toEqual(expect.arrayContaining(['Normalize amount', 'Loop items', 'Double item', 'Route total', 'Large total', 'Small total']))
        expect(steps.filter((step) => step.type === FlowActionType.CODE)).toHaveLength(4)
        const runs = await databaseConnection().getRepository<FlowRun>('flow_run').find({ where: { projectId: actor.project.id, flowId: flow.id }, order: { created: 'ASC' } })
        expect(runs).toHaveLength(2)
        const results = await Promise.all(runs.map((run) => flowRunService(app.log).getOnePopulatedOrThrow({ id: run.id, projectId: actor.project.id })))
        for (const result of results) {
            expect(result.status, JSON.stringify(result.steps)).toBe(FlowRunStatus.SUCCEEDED)
            expect(result.steps.step_2).toMatchObject({ output: { iterations: [{ step_3: { output: { doubled: 4 } } }, { step_3: { output: { doubled: 6 } } }] } })
        }
        expect(results[0].steps.step_1.output).toEqual({ total: 12, items: [2,3] })
        expect(results[0].steps.step_5.output).toEqual({ branch: 'high' })
        expect(results[0].steps.step_6).toBeUndefined()
        expect(results[0].steps.step_4.output).toMatchObject({ branches: [{ branchIndex: 1, evaluation: true }, { branchIndex: 2, evaluation: false }] })
        expect(results[1].steps.step_1.output).toEqual({ total: 3, items: [2,3] })
        expect(results[1].steps.step_6.output).toEqual({ branch: 'low' })
        expect(results[1].steps.step_5).toBeUndefined()
        expect(results[1].steps.step_4.output).toMatchObject({ branches: [{ branchIndex: 1, evaluation: false }, { branchIndex: 2, evaluation: true }] })
        expect(populated.status).toBe(FlowStatus.ENABLED)
        const delivered = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${flow.id}`, payload: { amount: 7 } })
        expect(delivered.statusCode).toBe(200)
        await vi.waitFor(async () => {
            const live = await databaseConnection().getRepository<FlowRun>('flow_run').findOneByOrFail({ projectId: actor.project.id, flowId: flow.id, environment: RunEnvironment.PRODUCTION })
            expect(live.status).toBe(FlowRunStatus.SUCCEEDED)
            const output = await flowRunService(app.log).getOnePopulatedOrThrow({ id: live.id, projectId: actor.project.id })
            expect(output.steps.trigger.output).toMatchObject({ body: { amount: 7 } })
            expect(output.steps.step_1.output).toEqual({ total: 21, items: [2,3] })
            expect(output.steps.step_5.output).toEqual({ branch: 'high' })
            expect(output.steps.step_6).toBeUndefined()
            expect(output.steps.step_4.output).toMatchObject({ branches: [{ branchIndex: 1, evaluation: true }, { branchIndex: 2, evaluation: false }] })
        }, { timeout: 60000, interval: 500 })
        const rendered = await runBrowser({ flowId: flow.id, nodes: steps.map((step) => ({ id: step.name, label: step.displayName })) })
        expect(rendered).toContain('"graphVisible":true')
    }, 210000)
})

function graphModel(): MockLanguageModelV4 {
    let index = 0
    const plan = [
        { name: 'ap_set_phase', input: { phase: 'build' } },
        { name: 'ap_build_flow', input: { flowName: 'Syd graph E2E', trigger: { pieceName: '@activepieces/piece-webhook', triggerName: 'catch_webhook', input: { authType: 'none' } }, steps: [{ type: 'CODE', displayName: 'Normalize amount', sourceCode: 'export const code = async (inputs) => ({ total: Number(inputs.amount) * 2, items: [2,3] });', input: { amount: '{{trigger.body.amount}}' } }] } },
        { name: 'ap_update_step', input: { stepName: 'step_1', sourceCode: 'export const code = async (inputs) => ({ total: Number(inputs.amount) * 3, items: [2,3] });' } },
        { name: 'ap_add_step', input: { parentStepName: 'step_1', stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER, stepType: 'LOOP_ON_ITEMS', displayName: 'Loop items', loopItems: '{{step_1.items}}' } },
        { name: 'ap_add_step', input: { parentStepName: 'step_2', stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_LOOP, stepType: 'CODE', displayName: 'Double item', sourceCode: 'export const code = async (inputs) => ({ doubled: Number(inputs.item) * 2 });', input: { item: '{{step_2.item}}' } } },
        { name: 'ap_add_step', input: { parentStepName: 'step_2', stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER, stepType: 'ROUTER', displayName: 'Route total' } },
        { name: 'ap_update_branch', input: { routerStepName: 'step_4', branchIndex: 0, branchName: 'Large total', conditions: [[{ firstValue: '{{step_1.total}}', operator: 'NUMBER_IS_GREATER_THAN', secondValue: '10' }]] } },
        { name: 'ap_add_step', input: { parentStepName: 'step_4', branchIndex: 0, stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_BRANCH, stepType: 'CODE', displayName: 'Large total', sourceCode: 'export const code = async () => ({ branch: "high" });' } },
        { name: 'ap_add_step', input: { parentStepName: 'step_4', branchIndex: 1, stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_BRANCH, stepType: 'CODE', displayName: 'Small total', sourceCode: 'export const code = async () => ({ branch: "low" });' } },
        { name: 'ap_test_flow', input: { triggerTestData: { body: { amount: 4 } } } },
        { name: 'ap_test_flow', input: { triggerTestData: { body: { amount: 1 } } } },
        { name: 'ap_lock_and_publish', input: {} },
    ]
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }
    return new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'Syd graph E2E' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }), doStream: async (options) => {
        const next = plan[index++]
        const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }]
        if (next) {
            const tool = options.tools?.find((item) => item.type === 'function' && item.name === next.name)
            if (!tool) { modelFailure = new Error(`Graph tool unavailable: ${next.name}`); throw modelFailure }
            const flow = next.name === 'ap_set_phase' || next.name === 'ap_build_flow' ? null : await databaseConnection().getRepository<Flow>('flow').findOneByOrFail({ projectId: actor.project.id })
            called = [...called, next.name]
            chunks.push({ type: 'tool-call', toolCallId: `graph-${index}`, toolName: next.name, input: JSON.stringify({ ...next.input, ...(flow ? { flowId: flow.id } : {}) }) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage })
        } else chunks.push({ type: 'text-start', id: 'done' }, { type: 'text-delta', id: 'done', delta: 'Graph built and tested with sample webhook data.' }, { type: 'text-end', id: 'done' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage })
        return { stream: simulateReadableStream({ chunks }) }
    } })
}

async function runBrowser({ flowId, nodes }: { flowId: string, nodes: { id: string, label: string }[] }): Promise<string> {
    return new Promise((resolve, reject) => {
        let output = ''
        const child = spawn(process.execPath, ['packages/tests-e2e/syd/assert-graph.cjs'], { env: { ...process.env, SYD_GRAPH_BROWSER_INPUT: JSON.stringify({ url: browserUrl, token: actor.token, projectId: actor.project.id, flowId, nodes }) }, stdio: 'pipe' })
        child.stdout.on('data', (data: Buffer) => { output += data.toString() })
        child.stderr.on('data', (data: Buffer) => { output += data.toString() })
        child.on('error', reject)
        child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output)))
    })
}
