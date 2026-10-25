import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FetchError } from '@activepieces/shared'
import { retryFetch } from '../../src/lib/api/retry-fetch'
import { createFlowsContext } from '../../src/lib/piece-context/flows'

vi.mock('../../src/lib/api/retry-fetch', () => ({ retryFetch: vi.fn() }))

const params = { engineToken: 'scoped-engine-token', internalApiUrl: 'http://engine.test/api/', flowId: 'current-flow', flowVersionId: 'current-version' }

beforeEach(() => vi.mocked(retryFetch).mockReset())

describe('engine scoped flow summaries', () => {
    it('lists without parameters and exposes the version name while preserving pagination', async () => {
        const row = { id: 'visible-flow', version: { displayName: 'Existing Mission' } }
        vi.mocked(retryFetch).mockResolvedValue(new Response(JSON.stringify({ data: [row], next: 'cursor', previous: null }), { status: 200 }))
        const context = createFlowsContext(params)
        expect(await context.list()).toEqual({ data: [{ ...row, displayName: 'Existing Mission' }], next: 'cursor', previous: null })
        expect(retryFetch).toHaveBeenCalledWith('http://engine.test/api/v1/engine/populated-flows?', { method: 'GET', headers: { Authorization: 'Bearer scoped-engine-token' } })
        expect(context.current).toEqual({ id: 'current-flow', version: { id: 'current-version' } })
    })

    it('encodes external IDs without changing the authorization scope', async () => {
        vi.mocked(retryFetch).mockResolvedValue(new Response(JSON.stringify({ data: [], next: null, previous: null }), { status: 200 }))
        await createFlowsContext(params).list({ externalIds: ['external one', 'external&two'] })
        const [url, options] = vi.mocked(retryFetch).mock.calls[0]
        expect(new URL(String(url)).searchParams.get('externalIds')).toBe('external one,external&two')
        expect(options?.headers).toEqual({ Authorization: 'Bearer scoped-engine-token' })
    })

    it('does not turn an authorization failure into an empty successful list', async () => {
        vi.mocked(retryFetch).mockResolvedValue(new Response('', { status: 403 }))
        await expect(createFlowsContext(params).list()).rejects.toBeInstanceOf(FetchError)
    })
})
