import Ajv, { AnySchema } from 'ajv'
import { z } from 'zod'
import { hostingFail } from './hosting-transactions'

const field = z.strictObject({ name: z.string().min(1).max(128), description: z.string().max(1024).optional(), type: z.enum(['string', 'number', 'boolean']), isRequired: z.boolean() })
const keywords = new Set(['$schema', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'])

export function hostedExtractionSchema(input: { mode: 'simple' | 'advanced', fields: unknown }) {
    let schema: unknown = input.fields
    if (input.mode === 'simple') {
        const parsed = z.array(field).min(1).max(100).safeParse(input.fields)
        if (!parsed.success || new Set(parsed.data.map(value => value.name)).size !== parsed.data.length) hostingFail('HOSTING_AI_SCHEMA_INVALID')
        schema = { type: 'object', properties: Object.fromEntries(parsed.data.map(value => [value.name, { type: value.type, ...(value.description ? { description: value.description } : {}) }])), required: parsed.data.filter(value => value.isRequired).map(value => value.name), additionalProperties: false }
    }
    if (Buffer.byteLength(JSON.stringify(schema) ?? '') > 8192) hostingFail('HOSTING_AI_SCHEMA_LIMIT')
    boundTree(schema, 8, 256)
    reviewSchema(schema)
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !('type' in schema) || schema.type !== 'object') hostingFail('HOSTING_AI_SCHEMA_INVALID')
    const ajv = new Ajv({ allErrors: false, strict: true, allowUnionTypes: true, validateFormats: false, ownProperties: true, addUsedSchema: false })
    try {
        const validate = ajv.compile(schema as AnySchema)
        return { schema, parse(answer: string): unknown {
            let output: unknown
            try {
                output = JSON.parse(answer) 
            }
            catch {
                hostingFail('HOSTING_AI_EXTRACTION_INVALID') 
            }
            boundTree(output, 12, 1000)
            if (!validate(output)) hostingFail('HOSTING_AI_EXTRACTION_INVALID')
            return output
        } }
    }
    catch {
        hostingFail('HOSTING_AI_SCHEMA_INVALID') 
    }
}

function reviewSchema(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) hostingFail('HOSTING_AI_SCHEMA_INVALID')
    const schema = value as Record<string, unknown>
    if (Object.keys(schema).some(key => !keywords.has(key))) hostingFail('HOSTING_AI_SCHEMA_UNSUPPORTED')
    if (schema.properties !== undefined) {
        if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) hostingFail('HOSTING_AI_SCHEMA_INVALID')
        for (const [name, child] of Object.entries(schema.properties)) {
            if (name.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(name)) hostingFail('HOSTING_AI_SCHEMA_INVALID')
            reviewSchema(child)
        }
    }
    if (schema.items !== undefined) reviewSchema(schema.items)
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') reviewSchema(schema.additionalProperties)
}

function boundTree(value: unknown, maxDepth: number, maxNodes: number): void {
    const pending: { value: unknown, depth: number }[] = [{ value, depth: 0 }]
    let nodes = 0
    while (pending.length > 0) {
        const current = pending.pop()!
        if (++nodes > maxNodes || current.depth > maxDepth) hostingFail('HOSTING_AI_SCHEMA_LIMIT')
        if (current.value && typeof current.value === 'object') for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 })
    }
}
