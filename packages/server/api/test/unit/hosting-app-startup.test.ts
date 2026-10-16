import fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/app/hosting/hosting-bootstrap', () => ({
    hostingBootstrap: { verify: vi.fn().mockRejectedValue(new Error('HOSTED_IMPLEMENTATION_INCOMPLETE')) },
}))

import { setupApp } from '../../src/app/app'

describe('unfinished hosted startup', () => {
    it('registers no application routes or background services after bootstrap refusal', async () => {
        const app = fastify()
        const register = vi.spyOn(app, 'register')
        try {
            await expect(setupApp(app)).rejects.toThrow('HOSTED_IMPLEMENTATION_INCOMPLETE')
            expect(register).not.toHaveBeenCalled()
        }
        finally { await app.close() }
    })
})
