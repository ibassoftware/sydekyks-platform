import { PrincipalType } from '@activepieces/shared'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { securityAccess } from '../../src/app/core/security/authorization/fastify-security'
import { authenticationMiddleware } from '../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../src/app/core/security/v2/authz/authorization-middleware'
import { errorHandler } from '../../src/app/helper/error-handler'

describe('authorization for unmatched HTTP routes', () => {
    it('preserves Fastify 404 for unmatched reads and retired enrollment-free writes', async () => {
        const app = fastify()
        app.setErrorHandler(errorHandler)
        app.addHook('preHandler', authenticationMiddleware)
        app.addHook('preHandler', authorizationMiddleware)
        try {
            for (const method of ['GET', 'POST'] as const) {
                const response = await app.inject({ method, url: '/api/v1/lms/progress', ...(method === 'POST' ? { payload: { lessonId: 'synthetic', completed: true } } : {}) })
                expect(response.statusCode, response.body).toBe(404)
            }
        }
        finally {
            await app.close()
        }
    })
    it('still rejects unauthenticated requests to registered protected routes', async () => {
        const app = fastify()
        app.setErrorHandler(errorHandler)
        app.addHook('preHandler', authenticationMiddleware)
        app.addHook('preHandler', authorizationMiddleware)
        let called = false
        app.get('/protected', { config: { security: securityAccess.unscoped([PrincipalType.USER]) } }, async () => {
            called = true
            return { private: true }
        })
        try {
            const response = await app.inject({ url: '/protected' })
            expect(response.statusCode).toBeGreaterThanOrEqual(400)
            expect(response.statusCode).toBeLessThan(500)
            expect(called).toBe(false)
            expect(response.body).not.toContain('"private":true')
        }
        finally {
            await app.close()
        }
    })
})
