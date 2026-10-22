import { createHash } from 'node:crypto'
import { flowStructureUtil } from '@activepieces/core-execution'
import { ActivepiecesError, apId, ApId, ErrorCode, tryCatch } from '@activepieces/core-utils'
import { AgentConfig, AgentConversationStatus, AgentOutputField, AgentPieceProps, AgentRunSource, AgentTool, AgentVisibility, AIProviderName, MAX_AGENT_OUTPUT_FIELDS, MAX_AGENT_STEP_BUDGET, MAX_AGENT_TEXT_LENGTH, MAX_AGENT_TOOLS, PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { databaseConnection } from '../../database/database-connection'
import { redisConnections } from '../../database/redis-connections'
import { flowRunService } from '../../flows/flow-run/flow-run-service'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { HostingDispatchEntity } from '../../hosting/hosting-dispatch-entity'
import { projectService } from '../../project/project-service'
import { UserEntity } from '../../user/user-entity'
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
        const hosted = hostingConfiguration.getServiceMode() === 'hosted'
        const parent = hosted ? await databaseConnection().getRepository(HostingDispatchEntity).findOneBy({ admissionId: request.principal.id, projectId, platformId: platform.id, flowRunId: flowRun.id }) : null
        const actorUser = parent ? await databaseConnection().getRepository(UserEntity).findOneBy({ identityId: parent.identityId, platformId: platform.id }) : null
        if (hosted && !actorUser) throw invalid('This mission step no longer has an admitted caller')
        if (hosted) {
            const prior = await databaseConnection().getRepository(HostingDispatchEntity).findOneBy({ platformId: platform.id, projectId, rootKey: `agent-step:${body.waitpointId}` })
            if (prior?.payload?.jobType === 'EXECUTE_AGENT_RUN' && prior.payload.runId) {
                if (prior.state === 'cancelled') throw invalid('This agent step was refused before it could run')
                return { conversationId: prior.payload.conversationId, runId: prior.payload.runId }
            }
            const version = await flowVersionService(request.log).getFlowVersionOrThrow({ flowId: flowRun.flowId, versionId: flowRun.flowVersionId, projectId, platformId: platform.id })
            const step = flowStructureUtil.getStep(waitpoint.stepName, version.trigger)
            if (!step || !flowStructureUtil.isAgentPiece(step) || step.settings.actionName !== 'run_agent') throw invalid('The waiting mission step is not an Agent action')
            if (body.nativeWebSearch && step.settings.input.webSearch !== true) throw invalid('Web search was not enabled on this mission step')
        }
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
        if (!hosted && !await redis.set(claimKey, '1', 'EX', 7200, 'NX')) throw invalid('An agent run has already started for this step')
        const result = await tryCatch(async () => {
            const id = hosted ? createHash('sha256').update(`agent-conversation:${platform.id}:${projectId}:${body.waitpointId}`).digest('hex').slice(0, 21) : apId()
            const saved = { id, platformId: platform.id, projectId, userId: actorUser?.id ?? project.ownerId, source: AgentRunSource.FLOW_STEP, agentId, flowRunId: flowRun.id, title: null, modelName: config.modelName ?? null, status: AgentConversationStatus.IDLE, activeRunId: null, messages: [], uiMessages: [], summary: null, summarizedUpToIndex: null, aiCredits: null }
            if (hosted) await sydAgentRuntime.repo().createQueryBuilder().insert().values(saved).orIgnore().execute()
            else await sydAgentRuntime.repo().save(saved)
            const conversation = await sydAgentRuntime.repo().findOneByOrFail({ id, platformId: platform.id, projectId, flowRunId: flowRun.id })
            return sydAgentRuntime.start({ conversation, config, content: body.instruction, waitpointId: body.waitpointId, ...(hosted ? { nativeFileIds: body.nativeFileIds, nativeWebSearch: body.nativeWebSearch, tokenVersion: parent?.tokenVersion, hostedOrigin: { type: 'agent-step' as const, admissionId: request.principal.id, waitpointId: body.waitpointId } } : {}), log: request.log })
        })
        if (result.error) {
            if (!hosted) await redis.del(claimKey)
            throw result.error
        }
        return result.data
    })
}

function invalid(message: string) {
    return new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message } })
}
const runRequest = z.object({ nativeFileIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{21}$/)).max(4).optional(), nativeWebSearch: z.boolean().optional(), instruction: z.string().min(1).max(MAX_AGENT_TEXT_LENGTH), flowRunId: ApId, waitpointId: ApId, agentId: z.optional(ApId), provider: z.enum(AIProviderName).optional(), providerConfigId: z.string().optional(), modelName: z.string().optional(), tools: z.array(AgentTool).max(MAX_AGENT_TOOLS).optional(), structuredOutput: z.array(AgentOutputField).max(MAX_AGENT_OUTPUT_FIELDS).optional(), maxSteps: z.number().int().positive().max(MAX_AGENT_STEP_BUDGET).optional() })
