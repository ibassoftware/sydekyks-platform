import { createServer } from 'node:http'
import { Permission, PrincipalType, WebsocketServerEvent } from '@activepieces/shared'
import Fastify from 'fastify'
import { Server, Socket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { websocketService } from '../../src/app/core/websockets.service'
import { flowModule } from '../../src/app/flows/flow.module'

const services = vi.hoisted(() => ({ app: vi.fn(), principal: vi.fn(), permissions: vi.fn(), testFlow: vi.fn() }))
vi.mock('../../src/app/server', () => ({ get app() { return services.app() } }))
vi.mock('../../src/app/authentication/lib/access-token-manager', () => ({ accessTokenManager: () => ({ verifyPrincipal: services.principal }) }))
vi.mock('../../src/app/sydekyks-community/project-access', () => ({ communityAuthorization: { getUserPermissions: services.permissions } }))
vi.mock('../../src/app/flows/flow/flow-version.controller', () => ({ flowVersionController: async () => undefined }))
vi.mock('../../src/app/flows/flow/flow.controller', () => ({ flowController: async () => undefined }))
vi.mock('../../src/app/flows/step-run/sample-data.controller', () => ({ sampleDataController: async () => undefined }))
vi.mock('../../src/app/flows/flow-run/flow-run-service', () => ({ flowRunService: () => ({ test: services.testFlow }) }))

let closeServer: () => Promise<void>
let url: string
let initializedSocket: Promise<Socket>
const principal = { id: 'user-1', type: PrincipalType.USER, platform: { id: 'platform-1' } }

beforeEach(async () => {
    services.principal.mockReset().mockResolvedValue(principal)
    services.permissions.mockReset().mockResolvedValue(new Set([Permission.READ_FLOW, Permission.READ_MCP]))
    services.testFlow.mockReset().mockResolvedValue({ id: 'run-1' })
    const app = Fastify({ logger: false })
    await app.register(flowModule)
    await app.ready()
    const http = createServer()
    const io = new Server(http)
    services.app.mockReturnValue({ io, log: app.log })
    initializedSocket = new Promise((resolve, reject) => {
        io.on('connection', socket => {
            websocketService.init(socket, app.log).then(() => resolve(socket), reject)
        })
    })
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject)
        http.listen(0, '127.0.0.1', resolve)
    })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    url = `http://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=polling`
    closeServer = async () => {
        await new Promise<void>(resolve => io.close(() => resolve()))
        await app.close()
    }
})
afterEach(async () => { await closeServer() })

async function connectClient(): Promise<string> {
    const response = await fetch(url)
    const packet = await response.text()
    const handshake: unknown = JSON.parse(packet.slice(1))
    if (!handshake || typeof handshake !== 'object' || !('sid' in handshake) || typeof handshake.sid !== 'string') throw new Error('Missing test handshake')
    const sessionUrl = `${url}&sid=${handshake.sid}`
    await fetch(sessionUrl, { method: 'POST', body: '40{"token":"synthetic-token","projectId":"project-1"}', headers: { 'content-type': 'text/plain' } })
    await initializedSocket
    return sessionUrl
}

async function emitTestFlow(sessionUrl: string): Promise<void> {
    await fetch(sessionUrl, { method: 'POST', body: `42${JSON.stringify([WebsocketServerEvent.TEST_FLOW_RUN, { flowVersionId: 'version-1' }])}`, headers: { 'content-type': 'text/plain' } })
    await expect.poll(() => services.permissions.mock.calls.length).toBeGreaterThanOrEqual(2)
}

describe('Socket.IO execution authorization', () => {
    it('rejects a read-only operator test run through the real socket transport', async () => {
        const sessionUrl = await connectClient()
        await emitTestFlow(sessionUrl)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(services.testFlow).not.toHaveBeenCalled()
    })
    it('permits an authorized test run through the same transport', async () => {
        services.permissions.mockResolvedValue(new Set(Object.values(Permission)))
        const sessionUrl = await connectClient()
        await emitTestFlow(sessionUrl)
        await expect.poll(() => services.testFlow.mock.calls.length).toBe(1)
        expect(services.testFlow).toHaveBeenCalledWith({ projectId: 'project-1', flowVersionId: 'version-1', triggeredBy: principal.id })
    })
    it('disconnects a passive subscriber when project access is revoked', async () => {
        await connectClient()
        const socket = await initializedSocket
        expect(socket.connected).toBe(true)
        services.permissions.mockResolvedValue(new Set())
        await expect.poll(() => socket.connected, { timeout: 6500, interval: 100 }).toBe(false)
    }, 8000)
    it('disconnects before executing after the current session changes user', async () => {
        services.permissions.mockResolvedValue(new Set(Object.values(Permission)))
        const sessionUrl = await connectClient()
        const socket = await initializedSocket
        services.principal.mockResolvedValue({ ...principal, id: 'different-user' })
        await fetch(sessionUrl, { method: 'POST', body: `42${JSON.stringify([WebsocketServerEvent.TEST_FLOW_RUN, { flowVersionId: 'version-1' }])}`, headers: { 'content-type': 'text/plain' } })
        await expect.poll(() => socket.connected).toBe(false)
        expect(services.testFlow).not.toHaveBeenCalled()
    })
})
