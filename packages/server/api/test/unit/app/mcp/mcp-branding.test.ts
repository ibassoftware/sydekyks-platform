import { McpServerType, PopulatedMcpServer } from '@activepieces/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../../../../src/app/mcp/mcp-server-builder'
import { apSetupGuideTool } from '../../../../src/app/mcp/tools/ap-setup-guide'

vi.mock('../../../../src/app/mcp/mcp-usage-tracker', () => ({
    mcpUsageTracker: () => ({ resolveCallBilling: async () => ({ charge: () => undefined, refusalWhenOutOfCredits: async () => null }) }),
    withCallBilling: ({ execute }: { execute: () => Promise<unknown> }) => execute,
}))

const log = Fastify({ logger: false }).log
const mcp: PopulatedMcpServer = {
    id: 'branding-test',
    created: '2026-10-09T00:00:00.000Z',
    updated: '2026-10-09T00:00:00.000Z',
    platformId: null,
    projectId: null,
    type: McpServerType.PROJECT,
    token: 'unused-test-value',
    disabledTools: [],
    flows: [],
}

describe('Sydekyks MCP branding', () => {
    it('advertises Sydekyks identity and product vocabulary through protocol initialization', async () => {
        const server = await buildMcpServer({ mcp, platformDisabledTools: [], clientKey: null, clientId: 'branding-test', isInAppChat: false, log })
        const client = new Client({ name: 'branding-test', version: '1.0.0' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        try {
            await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
            expect(client.getServerVersion()).toMatchObject({
                name: 'Sydekyks',
                title: 'Sydekyks',
                websiteUrl: 'https://www.sydekyks.com',
            })
            const metadata = JSON.stringify(client.getServerVersion())
            expect(metadata).not.toMatch(/activepieces/i)
            expect(metadata).toContain('/branding/sydekyks-mark.svg')
            expect(client.getInstructions()).toContain('Refer to the product as Sydekyks')
            expect(client.getInstructions()).toContain('Command Centers for projects, Missions for flows, Gadgets for integrations')
            expect(client.getInstructions()).toContain('@activepieces/piece-slack are compatibility identifiers')
            const tools = await client.listTools()
            expect(tools.tools.some(tool => tool.name === 'ap_create_flow')).toBe(true)
            const templates = await client.listResourceTemplates()
            expect(templates.resourceTemplates[0].uriTemplate).toBe('sydekyks://empty')
        }
        finally {
            await client.close()
            await server.close()
        }
    })

    it('uses Sydekyks in the setup guidance sent to external assistants', async () => {
        const tool = apSetupGuideTool({ ...mcp, projectId: 'branding-project' }, log)
        const result = await tool.execute({ topic: 'connection' })
        const text = JSON.stringify(result)
        expect(text).toContain('Open your Sydekyks dashboard')
        expect(text).not.toContain('Activepieces dashboard')
    })
})
