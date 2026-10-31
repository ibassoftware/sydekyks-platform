import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { authenticationController } from './authentication.controller'
import { passwordController } from './password.controller'

export const authenticationModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(passwordController, { prefix: '/v1/authentication' })
    await app.register(authenticationController, {
        prefix: '/v1/authentication',
    })
}
