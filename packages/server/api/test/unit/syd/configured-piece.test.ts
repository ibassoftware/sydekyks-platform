import { FieldControlMode } from '@activepieces/core-piece-types'
import { PiecePropertyMap, Property, PieceAuth } from '@activepieces/pieces-framework'
import { apLogger } from '@activepieces/server-utils'
import { MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => {
    const metadata: PieceFixture = { name: '@activepieces/piece-test', version: '1.0.0', auth: null, actions: {} }
    return { metadata, execute: vi.fn(), resolve: vi.fn(), connection: vi.fn() }
})
vi.mock('../../../src/app/pieces/metadata/piece-metadata-service', () => ({ pieceMetadataService: () => ({ getOrThrow: async () => control.metadata }) }))
vi.mock('../../../src/app/app-connection/app-connection-service/app-connection-service', () => ({ appConnectionService: () => ({ getOneWithoutValue: control.connection }) }))
vi.mock('../../../src/app/mcp/tools/flow-run-utils', () => ({ executePieceActionRun: control.execute }))
vi.mock('../../../src/app/mcp/tools/mcp-utils', () => ({ mcpUtils: { normalizePieceName: (name: string) => name, executePropertyResolution: control.resolve } }))

import { sydConfiguredPiece } from '../../../src/app/syd/copilot/tools/configured-piece'

function modelFor(text: string): MockLanguageModelV4 {
    return new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] }) })
}

describe('configured piece input execution', () => {
    beforeEach(() => {
        control.metadata.actions = {}
        control.execute.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'Done' }] })
        control.resolve.mockReset()
        control.connection.mockReset()
    })
    it('extracts unpinned inputs through the real SDK while preserving configured values', async () => {
        control.metadata.actions.send = { displayName: 'Send', requireAuth: false, props: { destination: Property.ShortText({ displayName: 'Destination', required: true }), body: Property.LongText({ displayName: 'Body', required: true }) } }
        const result = await sydConfiguredPiece.execute({ piece: { pieceName: control.metadata.name, pieceVersion: '1.0.0', actionName: 'send', predefinedInput: { fields: { destination: { mode: FieldControlMode.CHOOSE_YOURSELF, value: 'configured-destination' } } } }, instruction: 'Say hello', model: modelFor('{"body":"Hello"}'), platformId: 'platform', projectId: 'project', log: apLogger.create() })
        expect(control.execute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', input: { destination: 'configured-destination', body: 'Hello' } }))
        expect(result.resolvedInput).toEqual({ destination: 'configured-destination', body: 'Hello' })
    })
    it('refuses a nested absolute custom API URL before an action can run', async () => {
        control.metadata.actions.custom_api_call = { displayName: 'Custom call', requireAuth: false, props: { url: Property.DynamicProperties({ displayName: 'URL', required: true, refreshers: [], props: async () => ({ url: Property.ShortText({ displayName: 'URL', required: true }) }) }) } }
        control.resolve.mockResolvedValue({ status: 'dynamic', props: { url: Property.ShortText({ displayName: 'URL', required: true }) } })
        await expect(sydConfiguredPiece.execute({ piece: { pieceName: control.metadata.name, actionName: 'custom_api_call' }, instruction: 'Call a URL', model: modelFor('{"url":{"url":"https://example.com/steal"}}'), platformId: 'platform', projectId: 'project', log: apLogger.create() })).rejects.toThrow()
        expect(control.execute).not.toHaveBeenCalled()
    })
    it('keeps protected inputs and authorization headers out of model context and reported inputs', () => {
        const visible = sydConfiguredPiece.visibleInputs({ properties: { password: PieceAuth.SecretText({ displayName: 'Password', required: true }), body: Property.LongText({ displayName: 'Body', required: true }), headers: Property.Object({ displayName: 'Headers', required: false }) }, input: { password: 'private-test-password', auth: 'connection', body: 'Hello', headers: { Authorization: 'private-test-token', 'Content-Type': 'application/json' } } })
        expect(JSON.stringify(visible)).not.toContain('private-test')
        expect(visible).toMatchObject({ body: 'Hello', headers: { 'Content-Type': 'application/json' } })
    })
})

type PieceFixture = { name: string, version: string, auth: null, actions: Record<string, { displayName: string, requireAuth: boolean, props: PiecePropertyMap }> }
