import { createHash } from 'node:crypto'
import { FieldControlMode, PredefinedInputsStructure } from '@activepieces/core-piece-types'
import { ActivepiecesError, connectionTemplate, ErrorCode, tryCatch } from '@activepieces/core-utils'
import { PiecePropertyMap, PropertyType } from '@activepieces/pieces-framework'
import { generateText, LanguageModel, Output } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { appConnectionService } from '../../../app-connection/app-connection-service/app-connection-service'
import { HostingJobOrigin } from '../../../hosting/hosting-execution'
import { executePieceActionRun } from '../../../mcp/tools/flow-run-utils'
import { mcpUtils, PropertyResolutionResult } from '../../../mcp/tools/mcp-utils'
import { pieceMetadataService } from '../../../pieces/metadata/piece-metadata-service'

async function execute({ piece, instruction, model, platformId, projectId, log, hostedOrigin, requestId }: ExecuteParams) {
    const metadata = await pieceMetadataService(log).getOrThrow({ platformId, projectId, name: piece.pieceName, version: piece.pieceVersion })
    const action = metadata.actions[piece.actionName]
    if (!action) throw invalid('The configured action no longer exists')
    const externalId = connectionTemplate.unwrapExternalId(piece.predefinedInput?.auth) ?? undefined
    const connection = externalId ? await appConnectionService(log).getOneWithoutValue({ platformId, projectId, externalId }) : null
    if (externalId && (!connection || mcpUtils.normalizePieceName(connection.pieceName) !== mcpUtils.normalizePieceName(piece.pieceName))) throw invalid('The configured connection is unavailable for this action')
    if (action.requireAuth && metadata.auth && !externalId) throw invalid('Configure a connection before running this action')
    const pinned = pinnedInputs(piece.predefinedInput)
    const resolve = (propertyName: string, input: Record<string, unknown>) => mcpUtils.executePropertyResolution({ pieceName: metadata.name, pieceVersion: metadata.version, actionOrTriggerName: piece.actionName, propertyName, input, ...(externalId ? { auth: externalId } : {}), projectId, platformId, log, ...(hostedOrigin?.type === 'agent-tool' ? { hostedOrigin: { ...hostedOrigin, key: createHash('sha256').update(JSON.stringify([hostedOrigin.key, propertyName, input])).digest('hex') }, requestId: createHash('sha256').update(JSON.stringify([requestId, propertyName, input])).digest('hex').slice(0, 21) } : {}) })
    const fields = Object.keys(action.props).filter((name) => !(name in pinned) && ![PropertyType.MARKDOWN, PropertyType.CUSTOM].includes(action.props[name].type))
    let values: Record<string, unknown> = { ...pinned }
    let pending = fields
    while (pending.length) {
        const ready = pending.filter((name) => {
            const property = action.props[name]
            const dependencies = 'refreshers' in property && Array.isArray(property.refreshers) ? property.refreshers : []
            return dependencies.every((dependency) => !pending.includes(dependency))
        })
        if (!ready.length) throw invalid('Action inputs contain circular dependencies')
        const shape = await schemas({ properties: Object.fromEntries(ready.map((name) => [name, action.props[name]])), input: values, resolve, depth: 0 })
        const { output } = await generateText({ model, output: Output.json(), prompt: `Extract action inputs from this instruction: ${instruction}\nPreviously filled inputs: ${JSON.stringify(visibleInputs({ input: values, properties: action.props }))}. For dropdowns, return the listed selection key; the server restores the original option value. Leave optional unspecified fields null. Return literal values, never template expressions. Required JSON schema: ${JSON.stringify(z.toJSONSchema(z.object(shape), { io: 'input' }))}.`, temperature: 0 })
        // Clean model-authored data before decoding selections. Native option
        // objects, booleans, arrays and nested nulls must survive unchanged.
        values = { ...values, ...z.object(shape).parse(literalInputs(z.record(z.string(), z.unknown()).parse(output))), ...pinned }
        pending = pending.filter((name) => !ready.includes(name))
    }
    if (piece.actionName === 'custom_api_call') {
        const url = typeof values.url === 'string' ? values.url : isRecord(values.url) && typeof values.url.url === 'string' ? values.url.url : undefined
        if (url && /^https?:\/\//i.test(url)) throw invalid('Custom API calls must use a path on the configured connection host')
    }
    const resolvedInput = { ...values, ...(externalId ? { auth: externalId } : {}) }
    const result = await executePieceActionRun({ projectId, pieceName: metadata.name, actionName: piece.actionName, input: resolvedInput, ...(externalId ? { connectionExternalId: externalId } : {}), log, hostedOrigin, requestId })
    return { result, resolvedInput: { ...visibleInputs({ input: values, properties: action.props }), ...(externalId ? { auth: 'Redacted' } : {}) }, actionDisplayName: action.displayName, ...(connection ? { connectionLabel: connection.displayName } : {}) }
}

async function schemas({ properties, input, resolve, depth }: SchemaParams): Promise<Record<string, z.ZodType>> {
    if (depth > 4) throw invalid('Action inputs nest too deeply')
    const entries = await Promise.all(Object.entries(properties).map(async ([name, property]) => {
        const dynamic = [PropertyType.DYNAMIC, PropertyType.DROPDOWN, PropertyType.MULTI_SELECT_DROPDOWN].includes(property.type)
        const resolution = dynamic ? await tryCatch(() => resolve(name, input)) : null
        if (dynamic && !resolution?.data) throw invalid(`Could not resolve action input ${name}`)
        let schema: z.ZodType
        const choices = resolution?.data?.status === 'options' ? resolution.data.options : 'options' in property ? property.options : null
        let selections = ''
        if (property.type === PropertyType.DYNAMIC) {
            if (resolution?.data?.status !== 'dynamic') throw invalid(`Could not resolve action fields for ${name}`)
            schema = z.object(await schemas({ properties: resolution.data.props, input, resolve, depth: depth + 1 }))
        }
        else if (property.type === PropertyType.DATE_RANGE) schema = z.object({ preset: z.string().nullable(), after: z.string().nullable(), before: z.string().nullable() })
        else if (property.type === PropertyType.NUMBER) schema = z.number()
        else if (property.type === PropertyType.CHECKBOX) schema = z.boolean()
        else if (property.type === PropertyType.ARRAY) schema = property.properties ? z.array(z.object(await schemas({ properties: property.properties, input, resolve, depth: depth + 1 }))) : z.array(z.union([z.string(), z.number(), z.boolean()]))
        else if ([PropertyType.DROPDOWN, PropertyType.STATIC_DROPDOWN, PropertyType.MULTI_SELECT_DROPDOWN, PropertyType.STATIC_MULTI_SELECT_DROPDOWN].includes(property.type)) {
            if (dynamic && resolution?.data?.status !== 'options') throw invalid(`Could not resolve action input ${name}`)
            const options = dropdownOptions(choices)
            const multiple = [PropertyType.MULTI_SELECT_DROPDOWN, PropertyType.STATIC_MULTI_SELECT_DROPDOWN].includes(property.type)
            if (!options.length && property.required && !multiple) throw invalid(`No available options for action input ${name}`)
            const keys = options.map((_, index) => `option_${index}`)
            const selection = keys.length ? z.enum(keys).transform(key => structuredClone(options[Number(key.slice(7))].value)) : z.never()
            schema = multiple ? z.array(selection) : keys.length ? selection : z.null()
            // Values may contain connection-scoped data (including access
            // tokens). Expose labels and opaque keys to the model, never values.
            selections = ` Allowed selections: ${JSON.stringify(options.map((option, index) => ({ label: option.label, key: keys[index] })))}`
        }
        else if (property.type === PropertyType.JSON || property.type === PropertyType.OBJECT) schema = z.record(z.string(), z.unknown())
        else if ([PropertyType.BASIC_AUTH, PropertyType.CUSTOM_AUTH, PropertyType.OAUTH2, PropertyType.OIDC, PropertyType.SECRET_TEXT].includes(property.type)) throw invalid(`Configure the protected field ${name} yourself`)
        else schema = z.string()
        const description = `${property.displayName}: ${property.description ?? ''}${selections}`
        return [name, (property.required ? schema : schema.nullable().optional()).describe(description)] satisfies [string, z.ZodType]
    }))
    return Object.fromEntries(entries)
}

function dropdownOptions(choices: unknown): Array<{ label: string, value: unknown }> {
    const options = Array.isArray(choices) ? choices : isRecord(choices) && Array.isArray(choices.options) ? choices.options : null
    if (!options || options.some(option => !isRecord(option) || typeof option.label !== 'string' || !('value' in option) || option.value === undefined)) throw invalid('Could not resolve dropdown options')
    return options as Array<{ label: string, value: unknown }>
}

function visibleInputs({ input, properties }: { input: Record<string, unknown>, properties: PiecePropertyMap }): Record<string, unknown> {
    const protectedTypes = [PropertyType.SECRET_TEXT, PropertyType.BASIC_AUTH, PropertyType.CUSTOM_AUTH, PropertyType.OAUTH2, PropertyType.OIDC]
    return Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'auth').map(([name, value]) => [name, properties[name] && protectedTypes.includes(properties[name].type) ? 'Redacted' : redactNamedSecrets(value)]))
}

function redactNamedSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactNamedSecrets)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /^(auth|authorization|proxy-authorization|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|(?:x[_-])?api[_-]?key|token|secret)$/i.test(key) ? 'Redacted' : redactNamedSecrets(entry)]))
}

function pinnedInputs(input?: PredefinedInputsStructure): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input?.fields ?? {}).flatMap(([name, field]) => field.mode === FieldControlMode.CHOOSE_YOURSELF ? [[name, field.value]] : field.mode === FieldControlMode.LEAVE_EMPTY ? [[name, undefined]] : []))
}
function literalInputs(input: Record<string, unknown>): Record<string, unknown> {
    const serialized = JSON.stringify(input, (key, value) => key === 'auth' || value === null ? undefined : typeof value === 'string' ? value.replaceAll('{{', '{ {') : value)
    return z.record(z.string(), z.unknown()).parse(JSON.parse(serialized))
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function invalid(message: string) {
    return new ActivepiecesError({ code: ErrorCode.ENGINE_OPERATION_FAILURE, params: { message } })
}

export const sydConfiguredPiece = { execute, pinnedInputs, literalInputs, visibleInputs }
type ExecuteParams = { hostedOrigin?: HostingJobOrigin, requestId?: string, piece: { pieceName: string, pieceVersion?: string, actionName: string, predefinedInput?: PredefinedInputsStructure }, instruction: string, model: LanguageModel, platformId: string, projectId: string, log: FastifyBaseLogger }
type SchemaParams = { properties: PiecePropertyMap, input: Record<string, unknown>, resolve: (name: string, input: Record<string, unknown>) => Promise<PropertyResolutionResult>, depth: number }
