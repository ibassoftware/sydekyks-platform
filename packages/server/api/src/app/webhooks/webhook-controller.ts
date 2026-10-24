
import { Permission } from '@activepieces/core-utils'
import { wideEvent } from '@activepieces/server-utils'
import {
    PrincipalType,
    RAW_PAYLOAD_HEADER,
    WebhookUrlParams,
    WebsocketClientEvent,
} from '@activepieces/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { FlowEntity } from '../flows/flow/flow.entity'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { hostingFail } from '../hosting/hosting-transactions'
import { triggerSourceService } from '../trigger/trigger-source/trigger-source-service'
import { convertRequest, extractHeaderFromRequest } from './webhook-request-converter'
import { HostedDraftActor, WebhookFlowVersionToRun, webhookService } from './webhook.service'

export const webhookController: FastifyPluginAsyncZod = async (app) => {
    const hosted = hostingConfiguration.getServiceMode() === 'hosted'
    const draftParams = {
        ...WEBHOOK_PARAMS,
        config: {
            security: hosted
                ? securityAccess.project([PrincipalType.USER], Permission.WRITE_RUN, { type: ProjectResourceType.TABLE, tableName: FlowEntity, lookup: { paramKey: 'flowId', entityField: 'id' } })
                : securityAccess.public(),
        },
    }


    app.all(
        '/:flowId/sync',
        WEBHOOK_PARAMS,
        async (request: FastifyRequest<{ Params: WebhookUrlParams }>, reply) => {
            wideEvent.set({
                flow: { id: request.params.flowId },
                webhook: {
                    method: request.method,
                    async: false,
                },
            })
            const response = await webhookService.handleWebhook({
                data: (projectId: string) => convertRequest(request, projectId, request.params.flowId),
                logger: request.log,
                flowId: request.params.flowId,
                async: false,
                flowVersionToRun: WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
                saveSampleData: hosted ? false : await triggerSourceService(request.log).existsByFlowId({
                    flowId: request.params.flowId,
                    simulate: true,
                }),
                execute: true,
                ...extractRawPayload(request),
                ...extractHeaderFromRequest(request),
            })
            wideEvent.set({ webhook: { responseStatus: response.status } })
            await reply
                .status(response.status)
                .headers(response.headers)
                .send(response.body)
        },
    )

    app.all(
        '/:flowId',
        WEBHOOK_PARAMS,
        async (request: FastifyRequest<{ Params: WebhookUrlParams }>, reply) => {
            wideEvent.set({
                flow: { id: request.params.flowId },
                webhook: {
                    method: request.method,
                    async: true,
                },
            })
            const response = await webhookService.handleWebhook({
                data: (projectId: string) => convertRequest(request, projectId, request.params.flowId),
                logger: request.log,
                flowId: request.params.flowId,
                async: true,
                saveSampleData: hosted ? false : await triggerSourceService(request.log).existsByFlowId({
                    flowId: request.params.flowId,
                    simulate: true,
                }),
                flowVersionToRun: WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
                execute: true,
                ...extractRawPayload(request),
                ...extractHeaderFromRequest(request),
            })
            wideEvent.set({ webhook: { responseStatus: response.status } })
            await reply
                .status(response.status)
                .headers(response.headers)
                .send(response.body)
        },
    )

    app.all('/:flowId/draft/sync', draftParams, async (request, reply) => {
        const response = await webhookService.handleWebhook({
            hostedDraftActor: hostedDraftActor(request),
            data: (projectId: string) => convertRequest(request, projectId, request.params.flowId),
            logger: request.log,
            flowId: request.params.flowId,
            async: false,
            saveSampleData: true,
            flowVersionToRun: WebhookFlowVersionToRun.LATEST,
            execute: true,
            onRunCreated: (run) => {
                app.io.to(run.projectId).emit(WebsocketClientEvent.TEST_FLOW_RUN_STARTED, run)
            },
            ...extractHeaderFromRequest(request),
        })
        await reply
            .status(response.status)
            .headers(response.headers)
            .send(response.body)
    })

    app.all('/:flowId/draft', draftParams, async (request, reply) => {
        const response = await webhookService.handleWebhook({
            hostedDraftActor: hostedDraftActor(request),
            onRunCreated: (run) => {
                app.io.to(run.projectId).emit(WebsocketClientEvent.TEST_FLOW_RUN_STARTED, run)
            },
            data: (projectId: string) => convertRequest(request, projectId, request.params.flowId),
            logger: request.log,
            flowId: request.params.flowId,
            async: true,
            saveSampleData: true,
            flowVersionToRun: WebhookFlowVersionToRun.LATEST,
            execute: true,
            ...extractHeaderFromRequest(request),
        })
        await reply
            .status(response.status)
            .headers(response.headers)
            .send(response.body)
    })

    app.all('/:flowId/test', WEBHOOK_PARAMS, async (request, reply) => {
        const response = await webhookService.handleWebhook({
            data: (projectId: string) => convertRequest(request, projectId, request.params.flowId),
            logger: request.log,
            flowId: request.params.flowId,
            async: true,
            saveSampleData: true,
            flowVersionToRun: WebhookFlowVersionToRun.LATEST,
            execute: false,
            ...extractHeaderFromRequest(request),
        })
        await reply
            .status(response.status)
            .headers(response.headers)
            .send(response.body)
    })

}


const WEBHOOK_PARAMS = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        params: WebhookUrlParams,
    },
}


function hostedDraftActor(request: FastifyRequest): HostedDraftActor | undefined {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return undefined
    if (request.principal?.type !== PrincipalType.USER || !request.projectId) hostingFail('HOSTING_AUTHENTICATED_DRAFT_REQUIRED')
    return { userId: request.principal.id, tokenVersion: request.principal.tokenVersion ?? null, projectId: request.projectId, platformId: request.principal.platform.id }
}

function extractRawPayload(request: FastifyRequest): { payload?: Record<string, unknown> } {
    const isRawPayload = request.headers[RAW_PAYLOAD_HEADER] === 'true'
        && request.headers.authorization
        && request.body != null
        && !Array.isArray(request.body)
        && !Buffer.isBuffer(request.body)
    if (isRawPayload) {
        return { payload: request.body as Record<string, unknown> }
    }
    return {}
}
