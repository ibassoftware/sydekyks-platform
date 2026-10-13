import { flowStructureUtil } from '@activepieces/core-execution'
import { ActivepiecesError, apId, ApId, ErrorCode, tryCatch } from '@activepieces/core-utils'
import { AgentConfig, AgentConversationStatus, AgentOutputField, AgentPieceProps, AgentRunSource, AgentTool, AgentVisibility, AIProviderName, MAX_AGENT_OUTPUT_FIELDS, MAX_AGENT_STEP_BUDGET, MAX_AGENT_TEXT_LENGTH, MAX_AGENT_TOOLS, PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { redisConnections } from '../../database/redis-connections'
import { flowRunService } from '../../flows/flow-run/flow-run-service'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { projectService } from '../../project/project-service'
import { waitpointService } from '../../waitpoints/waitpoint-service'
import { WaitpointStatus } from '../../waitpoints/waitpoint-types'
import { sydAgentRuntime } from './agent-runtime'
import { sydChatAgentAdministrationSupport } from './tools/chat-agent-administration'

export const sydAgentRunController: FastifyPluginAsyncZod = async (app) => {
    app.post('/runs', { config: { security: securityAccess.publicPlatform([PrincipalType.ENGINE]) }, schema: { body: runRequest } }, async (request) => {
        if (request.principal.type !== PrincipalType.ENGINE) throw invalid('A running mission is required')
        const { projectId, platform } = request.principal
        const body = request.body
        const [project, flowRun, waitpoint] = await Promise.all([projectService(request.log).getOneOrThrow(projectId), flowRunService(request.log).getOneOrThrow({ id: body.flowRunId, projectId }), waitpointService(request.log).findByIdAndFlowRunId({ waitpointId: body.waitpointId, flowRunId: body.flowRunId, projectId })])
        if (project.platformId !== platform.id || !waitpoint || waitpoint.status !== WaitpointStatus.PENDING) throw invalid('This mission step is no longer waiting for an agent')
        if (body.agentId && ((body.tools?.length ?? 0) > 0 || body.provider || body.modelName || body.providerConfigId || body.structuredOutput?.length || body.maxSteps)) throw invalid('A linked agent supplies its own configuration')
        let agentId: string | null = null
        let config = AgentConfig.parse({ instructions: body.instruction, provider: body.provider, providerConfigId: body.providerConfigId, modelName: body.modelName, tools: body.tools, structuredOutput: body.structuredOutput, maxSteps: body.maxSteps })
        if (body.agentId) {
            const version = await flowVersionService(request.log).getFlowVersionOrThrow({ flowId: flowRun.flowId, versionId: flowRun.flowVersionId, projectId, platformId: platform.id })
            const steps = flowStructureUtil.getAllSteps(version.trigger).filter((step) => step.name === waitpoint.stepName)
            if (!steps.length || steps.some((step) => !flowStructureUtil.isAgentPiece(step) || step.settings.input?.[AgentPieceProps.AGENT_ID] !== body.agentId)) throw invalid('The saved mission step did not select this agent')
            const agent = await sydChatAgentAdministrationSupport.agentRepo().findOneBy({ projectId, externalId: body.agentId, visibility: AgentVisibility.PROJECT })
            if (!agent?.published) throw invalid('The selected agent must be shared with the project and published')
            agentId = agent.id
            config = agent.published
        }
        sydAgentRuntime.validateTools(config)
        const redis = await redisConnections.useExisting()
        const claimKey = `syd:agent-waitpoint:${platform.id}:${projectId}:${body.waitpointId}`
        if (!await redis.set(claimKey, '1', 'EX', 7200, 'NX')) throw invalid('An agent run has already started for this step')
        const result = await tryCatch(async () => {
            const conversation = await sydAgentRuntime.repo().save({ id: apId(), platformId: platform.id, projectId, userId: project.ownerId, source: AgentRunSource.FLOW_STEP, agentId, flowRunId: flowRun.id, title: null, modelName: config.modelName ?? null, status: AgentConversationStatus.IDLE, activeRunId: null, messages: [], uiMessages: [], summary: null, summarizedUpToIndex: null, aiCredits: null })
            return sydAgentRuntime.start({ conversation, config, content: body.instruction, waitpointId: body.waitpointId, log: request.log })
        })
        if (result.error) {
            await redis.del(claimKey)
            throw result.error
        }
        return result.data
    })
}

function invalid(message: string) {
    return new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message } }) 
}
const runRequest = z.object({ instruction: z.string().min(1).max(MAX_AGENT_TEXT_LENGTH), flowRunId: ApId, waitpointId: ApId, agentId: z.optional(ApId), provider: z.enum(AIProviderName).optional(), providerConfigId: z.string().optional(), modelName: z.string().optional(), tools: z.array(AgentTool).max(MAX_AGENT_TOOLS).optional(), structuredOutput: z.array(AgentOutputField).max(MAX_AGENT_OUTPUT_FIELDS).optional(), maxSteps: z.number().int().positive().max(MAX_AGENT_STEP_BUDGET).optional() })
