import { TemplateType } from '@activepieces/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { communityTemplates } from '../../../../src/app/template/community-templates.service'

function legacyTemplate() {
    return {
        id: 'public-template', created: '2025-01-01T00:00:00.000Z', updated: '2025-02-01T00:00:00.000Z',
        name: 'Legacy mission', type: 'OFFICIAL', summary: 'A public template', description: '', tags: [],
        blogUrl: null, metadata: null, author: 'Community', categories: ['Engineering'], pieces: [], platformId: null,
        status: 'PUBLISHED', tables: null,
        flows: [{
            displayName: 'Legacy mission', valid: true, schemaVersion: '6', notes: [],
            trigger: {
                name: 'trigger', type: 'PIECE_TRIGGER', valid: true, displayName: 'Webhook',
                settings: {
                    pieceName: '@activepieces/piece-webhook', pieceVersion: '~0.1.0', triggerName: 'catch_webhook',
                    input: {}, inputUiInfo: { lastTestDate: '2025-01-01T00:00:00.000Z' },
                },
                nextAction: {
                    name: 'step_1', type: 'CODE', valid: true, displayName: 'Code',
                    settings: { input: {}, sourceCode: { code: 'return 1', packageJson: '{}' } },
                },
            },
        }],
    }
}

function respond(body: unknown, status = 200) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })))
}

afterEach(() => vi.unstubAllGlobals())

describe('community template catalog compatibility', () => {
    it('loads legacy catalog entries without dropping their graphs or import metadata', async () => {
        const template = legacyTemplate()
        respond({ data: [template], next: null, previous: null })
        const page = await communityTemplates.list({ type: TemplateType.OFFICIAL })
        expect(page.data).toHaveLength(1)
        expect(page.data[0].tables).toBeUndefined()
        const flow = page.data[0].flows?.[0]
        expect(flow?.schemaVersion).toBe('6')
        expect(flow?.trigger.nextAction).toEqual(template.flows[0].trigger.nextAction)
        expect(flow?.trigger.settings).toMatchObject(template.flows[0].trigger.settings)
        expect(flow?.trigger.lastUpdatedDate).toBe(template.updated)
    })

    it('uses the same compatibility path for template detail', async () => {
        respond(legacyTemplate())
        const template = await communityTemplates.getOrThrow('public-template')
        expect(template.flows?.[0].trigger.settings.propertySettings).toEqual({})
        expect(template.flows?.[0].trigger.nextAction.name).toBe('step_1')
    })

    it('preserves current timestamps and table definitions', async () => {
        const template = legacyTemplate()
        respond({ ...template, tables: [], flows: [{ ...template.flows[0], trigger: {
            ...template.flows[0].trigger, lastUpdatedDate: '2026-01-01T00:00:00.000Z',
        } }] })
        const result = await communityTemplates.getOrThrow(template.id)
        expect(result.tables).toEqual([])
        expect(result.flows?.[0].trigger.lastUpdatedDate).toBe('2026-01-01T00:00:00.000Z')
    })

    it('returns the category flag expected by the gallery', async () => {
        const flag = { id: 'TEMPLATES_CATEGORIES', created: '2025-01-01', updated: '2025-01-01', value: ['Engineering', 'Sales'] }
        respond(flag)
        expect(await communityTemplates.getCategories()).toEqual(flag)
    })

    it('rejects a broken catalog instead of treating it as empty', async () => {
        respond({ data: [{ ...legacyTemplate(), name: null }], next: null, previous: null })
        await expect(communityTemplates.list({})).rejects.toThrow()
    })

    it('reports upstream failures for both list and categories', async () => {
        respond({ message: 'Unavailable' }, 503)
        await expect(communityTemplates.list({})).rejects.toThrow('503')
        await expect(communityTemplates.getCategories()).rejects.toThrow('503')
    })

    it('keeps an actually empty catalog empty', async () => {
        respond({ data: [], next: null, previous: null })
        expect(await communityTemplates.list({})).toEqual({ data: [], next: null, previous: null })
    })
})
