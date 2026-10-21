import { PrincipalType, TriggerTestStrategy } from '@activepieces/shared'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { describe, expect, it, vi } from 'vitest'

const { runTriggerTest, flow } = vi.hoisted(() => ({
    runTriggerTest: vi.fn().mockResolvedValue({ data: [], next: null, previous: null }),
    flow: { id: 'f'.repeat(21), version: { id: 'v'.repeat(21) } },
}))
vi.mock('../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({ runExclusive: ({ fn }: { fn: () => Promise<unknown> }) => fn() }),
}))
vi.mock('../../src/app/flows/flow/flow.service', () => ({
    flowService: () => ({ getOnePopulatedOrThrow: vi.fn().mockResolvedValue(flow) }),
}))
vi.mock('../../src/app/trigger/trigger-events/trigger-event.service', () => ({
    triggerEventService: () => ({ test: runTriggerTest }),
}))
vi.mock('../../src/app/trigger/trigger-source/trigger-source-service', () => ({ triggerSourceService: () => ({}) }))
vi.mock('../../src/app/core/security/authorization/fastify-security', () => ({ securityAccess: { project: () => ({}) } }))

import { testTriggerController } from '../../src/app/trigger/test-trigger/test-trigger-controller'

describe('normal builder TEST caller provenance', () => {
    it('carries the authenticated actor through controller and service instead of trusting body fields', async () => {
        const app = Fastify()
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)
        app.addHook('onRequest', async request => {
            Object.assign(request, { projectId: 'p'.repeat(21), principal: { type: PrincipalType.USER, id: 'authenticated-user', tokenVersion: 'current-generation' } })
        })
        await app.register(testTriggerController, { prefix: '/test-trigger' })
        try {
            const response = await app.inject({
                method: 'POST', url: '/test-trigger', payload: {
                    projectId: 'p'.repeat(21), flowId: flow.id, flowVersionId: flow.version.id,
                    testStrategy: TriggerTestStrategy.TEST_FUNCTION,
                    hostedOrigin: { type: 'user', userId: 'forged-user', tokenVersion: 'forged-generation' },
                },
            })
            expect(response.statusCode).toBe(200)
            expect(runTriggerTest).toHaveBeenCalledWith({
                flow, projectId: 'p'.repeat(21),
                hostedOrigin: { type: 'user', userId: 'authenticated-user', tokenVersion: 'current-generation' },
            })
        }
        finally {
            await app.close() 
        }
    })
})
