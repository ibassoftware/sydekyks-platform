import { tryCatch } from '@activepieces/core-utils'
import { FastifyBaseLogger } from 'fastify'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { mcpOAuthTokenService } from '../../../mcp/oauth/token/mcp-oauth-token.service'

async function getMcpCredentials({ platformId, userId, log }: { platformId: string, userId: string, log: FastifyBaseLogger }): Promise<McpCredentials> {
    const result = await tryCatch(() => mcpOAuthTokenService.issueInternalAccessToken({ userId, platformId, projectId: null }))
    if (result.error) {
        log.warn({ error: result.error, platform: { id: platformId }, user: { id: userId } }, 'Syd MCP credentials are unavailable')
        return { mcpServerUrl: null, mcpToken: null }
    }
    return { mcpServerUrl: `${system.getOrThrow(AppSystemProp.FRONTEND_URL)}/mcp/platform`, mcpToken: result.data }
}

export const sydCopilotMcp = { getMcpCredentials, getCredentials: getMcpCredentials, CONVERSATION_ID_HEADER: 'x-ap-conversation-id' }

export type McpCredentials = { mcpServerUrl: string | null, mcpToken: string | null }
