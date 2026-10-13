import { isNil, Permission } from '@activepieces/core-utils'
import { McpToolDefinition, McpToolResult } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { communityAuthorization } from '../sydekyks-community/project-access'

export async function resolvePermissionChecker({ userId, projectId, log }: ResolveCheckerParams): Promise<PermissionChecker> {
    return buildPermissionChecker({ userId, projectId, log })
}

export async function resolveMcpPermissionChecker({ userId, projectId, log }: ResolveCheckerParams): Promise<PermissionChecker> {
    return buildPermissionChecker({ userId, projectId, log })
}

export const ALLOW_ALL: PermissionChecker = {
    check: () => null,
    wrapExecute: ({ execute }) => execute,
}

async function buildPermissionChecker({ userId, projectId, log }: ResolveCheckerParams): Promise<PermissionChecker> {
    const permissions = await communityAuthorization.getUserPermissions({ userId, projectId, log })
    return buildChecker((permission, toolTitle) => {
        const permitted = permissions.has(Permission.READ_MCP) && (permissions.has(permission ?? Permission.WRITE_FLOW))
        return permitted ? null : deny(`Permission denied for "${toolTitle}" in this workspace.`)
    })
}

function buildChecker(check: PermissionChecker['check']): PermissionChecker {
    return {
        check,
        wrapExecute: ({ execute, permission, toolTitle }) => {
            const denial = check(permission, toolTitle)
            return isNil(denial) ? execute : async () => denial
        },
    }
}

export function deny(text: string): McpToolResult {
    return { content: [{ type: 'text', text }], isError: true }
}

export type PermissionChecker = {
    check: (permission: Permission | undefined, toolTitle: string) => McpToolResult | null
    wrapExecute: (params: { execute: McpToolDefinition['execute'], permission: Permission | undefined, toolTitle: string }) => McpToolDefinition['execute']
}

type ResolveCheckerParams = {
    userId: string
    projectId: string
    log: FastifyBaseLogger
}
