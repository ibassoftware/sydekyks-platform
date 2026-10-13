import { Permission } from '@activepieces/core-utils'
import { PlatformRole, ProjectType } from '@activepieces/shared'
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpAccess } from '../../../../src/app/mcp/mcp-access'
import { db } from '../../../helpers/db'
import { McpClient, mcpClientHelpers } from '../../../helpers/mcp-client'
import { createMockProject } from '../../../helpers/mocks'
import { createTestContext, createWorkspaceUserContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance

const LOCKED_TOOL = 'ap_list_flows'
const PIECE_CATALOG_TOOL = 'ap_research_pieces'

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

function connectAs({ ctx }: { ctx: TestContext }): Promise<McpClient> {
    return mcpClientHelpers.connect({
        app,
        approve: (payload) => ctx.post('/v1/mcp-oauth/approve', payload),
    })
}

function call({ mcpClient, name, args }: { mcpClient: McpClient, name: string, args?: Record<string, unknown> }): Promise<string> {
    return mcpClientHelpers.callTool({ app, mcpClient, name, args })
}

describe('MCP access on community edition', () => {
    it('lets a read-only operator discover accessible team workspaces', async () => {
        const ctx = await createTestContext(app)
        const member = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.OPERATOR })

        const projects = await mcpAccess.listAccessibleProjects({ platformId: ctx.platform.id, userId: member.user.id, log: app.log })

        expect(projects.map(p => p.id)).toEqual([ctx.project.id])
    })

    it('lets a read-only operator connect and inspect flows', async () => {
        const ctx = await createTestContext(app)
        const member = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.OPERATOR })
        const mcpClient = await connectAs({ ctx: member })

        await call({ mcpClient, name: 'ap_set_project_context', args: { projectId: ctx.project.id } })
        const listed = await call({ mcpClient, name: LOCKED_TOOL })

        expect(listed).not.toContain('Permission denied')
    })

    it('lets a read-only operator research integrations', async () => {
        const ctx = await createTestContext(app)
        const member = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.OPERATOR })
        const mcpClient = await connectAs({ ctx: member })

        const researched = await call({ mcpClient, name: PIECE_CATALOG_TOOL, args: { query: 'slack' } })

        expect(researched).not.toContain('Permission denied')
    })

    it('refuses flow creation by a read-only operator', async () => {
        const ctx = await createTestContext(app)
        const operator = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.OPERATOR })
        const mcpClient = await connectAs({ ctx: operator })
        await call({ mcpClient, name: 'ap_set_project_context', args: { projectId: ctx.project.id } })

        const result = await call({ mcpClient, name: 'ap_create_flow', args: { flowName: 'Forbidden write' } })

        expect(result).toContain('Permission denied')
        expect(await db.findBy('flow', { projectId: ctx.project.id })).toEqual([])
    })

    it('does not grant a nonowning MEMBER workspace discovery or OAuth access', async () => {
        const ctx = await createTestContext(app)
        const member = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.MEMBER })

        const projects = await mcpAccess.listAccessibleProjects({ platformId: ctx.platform.id, userId: member.user.id, log: app.log })

        expect(projects).toEqual([])
        expect((await member.post('/v1/mcp-oauth/approve', { authRequestId: 'unused' })).statusCode).toBe(403)
    })

    it('keeps another user\'s personal workspace hidden from operators and admins', async () => {
        const ctx = await createTestContext(app)
        const personal = createMockProject({ platformId: ctx.platform.id, ownerId: ctx.user.id, type: ProjectType.PERSONAL })
        await db.save('project', personal)

        for (const platformRole of [PlatformRole.OPERATOR, PlatformRole.ADMIN]) {
            const user = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole })
            const projects = await mcpAccess.listAccessibleProjects({ platformId: ctx.platform.id, userId: user.user.id, log: app.log })
            expect(projects.map(project => project.id)).toContain(ctx.project.id)
            expect(projects.map(project => project.id)).not.toContain(personal.id)
        }
    })

    it('refuses a piece-catalog tool on an issued token once workspace access is revoked', async () => {
        const ctx = await createTestContext(app)
        const member = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.OPERATOR })
        const mcpClient = await connectAs({ ctx: member })
        expect(await call({ mcpClient, name: PIECE_CATALOG_TOOL, args: { query: 'slack' } })).not.toContain('Permission denied')

        await db.update('user', member.user.id, { platformRole: PlatformRole.MEMBER })

        expect(await call({ mcpClient, name: PIECE_CATALOG_TOOL, args: { query: 'slack' } })).toContain(Permission.READ_MCP)
    })

    it('refuses project selection on an issued token once workspace access is revoked', async () => {
        const ctx = await createTestContext(app)
        const member = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.OPERATOR })
        const mcpClient = await connectAs({ ctx: member })

        await db.update('user', member.user.id, { platformRole: PlatformRole.MEMBER })

        expect(await call({ mcpClient, name: 'ap_set_project_context', args: { projectId: ctx.project.id } })).toContain(Permission.READ_MCP)
    })

    it('refuses platform-wide authorization to a member without workspace access', async () => {
        const ctx = await createTestContext(app)
        const member = await createWorkspaceUserContext({ app, parentCtx: ctx, platformRole: PlatformRole.OPERATOR })
        await db.update('user', member.user.id, { platformRole: PlatformRole.MEMBER })

        const response = await member.post('/v1/mcp-oauth/approve', { authRequestId: 'unused' })

        expect(response.statusCode).toBe(403)
    })
})
