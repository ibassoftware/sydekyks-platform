import { FieldControlMode } from '@activepieces/core-piece-types'
import { PieceAuth, PiecePropertyMap, Property } from '@activepieces/pieces-framework'
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

function modelFor(text: string | string[]): MockLanguageModelV4 {
    let index = 0
    return new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : text[index++] }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] }) })
}

function executeWith(props: PiecePropertyMap, model: MockLanguageModelV4) {
    control.metadata.actions.search = { displayName: 'Search', requireAuth: false, props }
    return sydConfiguredPiece.execute({ piece: { pieceName: control.metadata.name, actionName: 'search' }, instruction: 'Use the requested option', model, platformId: 'platform', projectId: 'project', log: apLogger.create() })
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
    it.each(['UNREAD', 'INBOX'])('preserves the actual Gmail %s label object instead of generating label:undefined', async name => {
        const label = { id: name, name, type: 'system' }
        control.resolve.mockResolvedValue({ status: 'options', options: [{ label: name, value: label }] })
        control.execute.mockImplementation(async ({ input }) => ({ query: `label:${input.label.name}` }))
        const result = await executeWith({ label: Property.Dropdown({ displayName: 'Label', required: false, refreshers: [], options: async () => ({ options: [] }) }) }, modelFor('{"label":"option_0"}'))
        expect(result.result).toEqual({ query: `label:${name}` })
        expect(result.resolvedInput).toEqual({ label })
        expect(label).toEqual({ id: name, name, type: 'system' })
    })
    it.each(['read', 27, false, null])('preserves a native static dropdown value %j', async value => {
        const result = await executeWith({ selection: Property.StaticDropdown({ displayName: 'Selection', required: true, options: { options: [{ label: 'Requested', value }] } }) }, modelFor('{"selection":"option_0"}'))
        expect(control.execute).toHaveBeenCalledWith(expect.objectContaining({ input: { selection: value } }))
        expect(result.resolvedInput).toEqual({ selection: value })
    })
    it('preserves mixed multi-select values including nested arrays, booleans and nulls', async () => {
        const first = { id: 'repo', details: { archived: false, count: 0, owner: null }, fields: [null, 'name'] }
        control.resolve.mockResolvedValue({ status: 'options', options: [{ label: 'Repository', value: first }, { label: 'Numeric ID', value: 29 }] })
        const result = await executeWith({ selections: Property.MultiSelectDropdown({ displayName: 'Selections', required: true, refreshers: [], options: async () => ({ options: [] }) }) }, modelFor('{"selections":["option_0","option_1"]}'))
        expect(result.resolvedInput).toEqual({ selections: [first, 29] })
        expect(control.execute).toHaveBeenCalledWith(expect.objectContaining({ input: { selections: [first, 29] } }))
    })
    it('preserves static multi-select values', async () => {
        const props = { selections: Property.StaticMultiSelectDropdown({ displayName: 'Selections', required: false, options: { options: [{ label: 'Enabled', value: true }, { label: 'Object', value: { id: 'object' } }] } }) }
        const result = await executeWith(props, modelFor('{"selections":["option_1","option_0"]}'))
        expect(result.resolvedInput).toEqual({ selections: [{ id: 'object' }, true] })
    })
    it('uses restored values when resolving dependent dropdowns', async () => {
        control.resolve.mockImplementation(async ({ propertyName }) => propertyName === 'repository' ? { status: 'options', options: [{ label: 'Repository', value: { owner: 'team', name: 'repo' } }] } : { status: 'options', options: [{ label: 'Branch', value: 'main' }] })
        const props = {
            repository: Property.Dropdown({ displayName: 'Repository', required: true, refreshers: [], options: async () => ({ options: [] }) }),
            branch: Property.Dropdown({ displayName: 'Branch', required: true, refreshers: ['repository'], options: async () => ({ options: [] }) }),
        }
        const result = await executeWith(props, modelFor(['{"repository":"option_0"}', '{"branch":"option_0"}']))
        expect(control.resolve).toHaveBeenCalledWith(expect.objectContaining({ propertyName: 'branch', input: { repository: { owner: 'team', name: 'repo' } } }))
        expect(result.resolvedInput).toEqual({ repository: { owner: 'team', name: 'repo' }, branch: 'main' })
    })
    it('keeps option credentials out of model context and reported inputs while restoring them for the action', async () => {
        const value = { id: 'page', accessToken: 'synthetic-private-dropdown-token', nested: { clientSecret: 'synthetic-private-dropdown-secret', auth: 'synthetic-private-dropdown-auth' } }
        control.resolve.mockResolvedValue({ status: 'options', options: [{ label: 'Page', value }] })
        const model = modelFor('{"page":"option_0"}')
        const result = await executeWith({ page: Property.Dropdown({ displayName: 'Page', required: true, refreshers: [], options: async () => ({ options: [] }) }) }, model)
        expect(control.execute).toHaveBeenCalledWith(expect.objectContaining({ input: { page: value } }))
        expect(JSON.stringify(model.doGenerateCalls)).not.toContain('synthetic-private-dropdown')
        expect(JSON.stringify(result.resolvedInput)).not.toContain('synthetic-private-dropdown')
        expect(result.resolvedInput).toMatchObject({ page: { id: 'page', accessToken: 'Redacted', nested: { clientSecret: 'Redacted', auth: 'Redacted' } } })
    })
    it('rejects invented choices before executing an action', async () => {
        control.resolve.mockResolvedValue({ status: 'options', options: [{ label: 'Inbox', value: { name: 'INBOX', id: 'INBOX' } }] })
        await expect(executeWith({ label: Property.Dropdown({ displayName: 'Label', required: true, refreshers: [], options: async () => ({ options: [] }) }) }, modelFor('{"label":"INBOX"}'))).rejects.toThrow()
        expect(control.execute).not.toHaveBeenCalled()
    })
    it('omits unspecified optional fields and keeps an empty multi-select valid', async () => {
        control.resolve.mockResolvedValue({ status: 'options', options: [] })
        const result = await executeWith({ label: Property.Dropdown({ displayName: 'Label', required: false, refreshers: [], options: async () => ({ options: [] }) }), selections: Property.StaticMultiSelectDropdown({ displayName: 'Selections', required: true, options: { options: [] } }), note: Property.ShortText({ displayName: 'Note', required: false }) }, modelFor('{"label":null,"selections":[],"note":null}'))
        expect(result.resolvedInput).toEqual({ selections: [] })
    })
    it('fails closed when required options cannot be resolved', async () => {
        control.resolve.mockResolvedValue({ status: 'failed', message: 'Options unavailable' })
        const model = modelFor('{"label":"option_0"}')
        await expect(executeWith({ label: Property.Dropdown({ displayName: 'Label', required: true, refreshers: [], options: async () => ({ options: [] }) }) }, model)).rejects.toThrow()
        expect(model.doGenerateCalls).toHaveLength(0)
        expect(control.execute).not.toHaveBeenCalled()
    })
    it('normalizes model-authored fields before restoring values inside dynamic fields', async () => {
        control.resolve.mockImplementation(async ({ propertyName }) => propertyName === 'fields' ? { status: 'dynamic', props: { label: Property.StaticDropdown({ displayName: 'Label', required: true, options: { options: [{ label: 'Inbox', value: { id: 'INBOX', extra: null } }] } }), optional: Property.ShortText({ displayName: 'Optional', required: false }) } } : { status: 'options', options: [] })
        const props = { fields: Property.DynamicProperties({ displayName: 'Fields', required: true, refreshers: [], props: async () => ({}) }), text: Property.ShortText({ displayName: 'Text', required: true }) }
        const result = await executeWith(props, modelFor('{"fields":{"label":"option_0","optional":null},"text":"{{untrusted}}","auth":"invented"}'))
        expect(result.resolvedInput).toEqual({ fields: { label: { id: 'INBOX', extra: null } }, text: '{ {untrusted}}' })
    })
})

type PieceFixture = { name: string, version: string, auth: null, actions: Record<string, { displayName: string, requireAuth: boolean, props: PiecePropertyMap }> }
