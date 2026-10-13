import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { FastifyBaseLogger } from 'fastify'

function containsSecretManagerReference(value: unknown): boolean {
    if (typeof value === 'string') return /secret[_-]?managers?\s*[.:[/]/i.test(value)
    if (Array.isArray(value)) return value.some(containsSecretManagerReference)
    if (value && typeof value === 'object') return Object.values(value).some(containsSecretManagerReference)
    return false
}

async function resolveObject<T>({ value }: { value: T, platformId: string, projectIds?: string[], throwOnFailure?: boolean }): Promise<T> {
    if (containsSecretManagerReference(value)) throw new ActivepiecesError({ code: ErrorCode.FEATURE_DISABLED, params: { message: 'Configure credentials directly; external secret managers are not supported in this release' } })
    return value
}

async function resolveString({ value, key }: { value?: string, key?: string, platformId: string, projectIds?: string[], throwOnFailure?: boolean }): Promise<string> {
    return resolveObject({ value: value ?? key ?? '', platformId: '', projectIds: [] })
}

export const secretManagersService = (_log: FastifyBaseLogger) => ({ resolveObject, resolveString })
export { containsSecretManagerReference }
