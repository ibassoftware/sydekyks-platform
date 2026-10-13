import { ActivepiecesError, ErrorCode, isNil, SeekPage } from '@activepieces/core-utils'
import { EmptyTrigger, Flag, FlowVersionTemplate, ListTemplatesRequestQuery, PieceTrigger, PieceTriggerSettings, Template } from '@activepieces/shared'
import { z } from 'zod'

const TEMPLATES_SOURCE_URL = 'https://cloud.activepieces.com/api/v1/templates'

export const communityTemplates = {
    getOrThrow: async (id: string): Promise<Template> => {
        const url = `${TEMPLATES_SOURCE_URL}/${id}`
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        })
        if (!response.ok) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'template',
                    entityId: id,
                    message: `Template ${id} not found`,
                },
            })
        }
        const template = parseCommunityTemplate(await response.json())
        return template
    },
    getCategories: async (): Promise<Flag> => {
        const url = `${TEMPLATES_SOURCE_URL}/categories`
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        })
        assertCatalogResponse(response)
        const categories = z.object({ id: z.string(), created: z.string(), updated: z.string(), value: z.array(z.string()) }).parse(await response.json())
        return categories
    },
    list: async (request: ListTemplatesRequestQuery): Promise<SeekPage<Template>> => {
        const queryString = convertToQueryString(request)
        const url = `${TEMPLATES_SOURCE_URL}?${queryString}`
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        })
        assertCatalogResponse(response)
        const page = z.object({ data: z.array(z.unknown()), next: z.string().nullable(), previous: z.string().nullable() }).parse(await response.json())
        return { ...page, data: page.data.map(parseCommunityTemplate) }
    },
}


function convertToQueryString(params: ListTemplatesRequestQuery): string {
    const searchParams = new URLSearchParams()

    Object.entries(params).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            value.forEach((val) => {
                if (!isNil(val)) {
                    searchParams.append(key, typeof val === 'string' ? val : JSON.stringify(val))
                }
            })
        }
        else if (!isNil(value)) {
            searchParams.set(key, value.toString())
        }
    })

    return searchParams.toString()
}

function parseCommunityTemplate(value: unknown): Template {
    const template = Template.extend({
        flows: z.array(z.unknown()).optional(),
        tables: Template.shape.tables.nullable(),
    }).parse(value)
    const legacyTrigger = z.union([
        PieceTrigger.extend({
            lastUpdatedDate: z.string().default(template.updated),
            settings: PieceTriggerSettings.extend({
                propertySettings: PieceTriggerSettings.shape.propertySettings.default({}),
            }).passthrough(),
        }).passthrough(),
        EmptyTrigger.extend({ lastUpdatedDate: z.string().default(template.updated) }).passthrough(),
    ])
    const flows = template.flows?.map((flow) => FlowVersionTemplate.extend({ trigger: legacyTrigger }).parse(flow))
    return { ...Template.parse({ ...template, tables: template.tables ?? undefined, flows }), flows }
}

function assertCatalogResponse(response: Response): void {
    if (!response.ok) {
        throw new Error(`Template catalog request failed (${response.status})`)
    }
}
