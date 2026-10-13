import { sydTestEntitlement } from '../../../helpers/syd-test-entitlement'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let restoreEntitlementKey = () => {}
let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
    restoreEntitlementKey = await sydTestEntitlement.activate()
})

afterAll(async () => {
    restoreEntitlementKey()
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
})

describe('licensed Community assistant capabilities', () => {
    it('registers capability configuration for a licensed platform administrator', async () => {
        const response = await ctx.get('/v1/ai-tools')

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json()).toEqual([])
    })
})
