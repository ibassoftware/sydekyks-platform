import { AIProviderName } from '@activepieces/core-utils'
import fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { config, project, hosted } = vi.hoisted(() => ({
    config: vi.fn(),
    project: vi.fn(),
    hosted: vi.fn(() => { throw new Error('SELF_HOSTED_MUST_NOT_USE_HOSTED_WALLET') }),
}))
vi.mock('../../src/app/hosting/hosting-services', () => ({ hostingServices: { gateway: hosted, ledger: hosted, execution: hosted } }))
vi.mock('../../src/app/ai/ai-provider-service', () => ({ aiProviderService: () => ({ getConfigOrThrow: config, assertKeyAllowsModel: vi.fn() }) }))
vi.mock('../../src/app/project/project-service', () => ({ projectService: () => ({ getOneOrThrow: project }) }))
vi.mock('../../src/app/file/file.service', () => ({ fileService: vi.fn() }))
vi.mock('../../src/app/file/files-service', () => ({ filesService: {} }))
vi.mock('../../src/app/flows/flow-run/flow-run-service', () => ({ flowRunService: vi.fn() }))
vi.mock('../../src/app/waitpoints/resume-service', () => ({ resumeService: vi.fn() }))
vi.mock('../../src/app/ai/ai-model-candidates', () => ({ aiModelCandidates: vi.fn() }))
vi.mock('../../src/app/ai/ai-usage-service', () => ({ aiUsageService: vi.fn() }))

import { aiRpcHandlers } from '../../src/app/ai/ai-rpc-handlers'

beforeEach(() => {
    vi.clearAllMocks()
    project.mockResolvedValue({ id: 'project', platformId: 'platform' })
    config.mockResolvedValue({ configId: 'self-hosted-config', apiKey: 'synthetic-local-provider-key' })
})
afterEach(() => vi.unstubAllEnvs())

describe('self-hosted AI provider resolution remains independent of hosted Credits', () => {
    it.each([undefined, 'self_hosted'])('resolves the installation provider without hosted configuration in mode %s', async mode => {
        vi.stubEnv('AP_SERVICE_MODE', mode)
        for (const setting of ['AP_HOSTED_OPERATOR_IDENTITY_IDS', 'AP_HOSTED_DEEPSEEK_API_KEY', 'AP_HOSTED_STRIPE_SECRET_KEY']) vi.stubEnv(setting, undefined)
        const result = await aiRpcHandlers(fastify().log).resolveAiProvider({
            platformId: 'platform', projectId: 'project', provider: AIProviderName.OPENAI,
        })
        expect(result.providerConfigId).toBe('self-hosted-config')
        expect(config).toHaveBeenCalledExactlyOnceWith({ platformId: 'platform', provider: AIProviderName.OPENAI, scope: { type: 'project', projectId: 'project' } })
        expect(hosted).not.toHaveBeenCalled()
    })

    it('retains project ownership checks in the default mode', async () => {
        vi.stubEnv('AP_SERVICE_MODE', undefined)
        project.mockResolvedValue({ id: 'project', platformId: 'another-platform' })
        await expect(aiRpcHandlers(fastify().log).resolveAiProvider({
            platformId: 'platform', projectId: 'project', provider: AIProviderName.OPENAI,
        })).rejects.toThrow()
        expect(config).not.toHaveBeenCalled()
        expect(hosted).not.toHaveBeenCalled()
    })

    it('requires the managed gateway when hosted mode is explicitly enabled', async () => {
        vi.stubEnv('AP_SERVICE_MODE', 'hosted')
        await expect(aiRpcHandlers(fastify().log).resolveAiProvider({
            platformId: 'platform', projectId: 'project', provider: AIProviderName.OPENAI,
        })).rejects.toThrow('HOSTING_GATEWAY_REQUIRED')
        expect(config).not.toHaveBeenCalled()
    })
})
