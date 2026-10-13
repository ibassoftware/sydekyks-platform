import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { PlatformRole, PrincipalType } from '@activepieces/shared'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { describe, expect, it, vi } from 'vitest'
import { invitationModule } from '../../src/app/user-invitations/user-invitation.module'

const mocks=vi.hoisted(()=>({user:vi.fn(),platform:vi.fn(),list:vi.fn()}))
vi.mock('../../src/app/user/user-service',()=>({userService:()=>({getOrThrow:mocks.user})}))
vi.mock('../../src/app/platform/platform.service',()=>({platformService:()=>({getOneOrThrow:mocks.platform})}))
vi.mock('../../src/app/user-invitations/user-invitation.service',()=>({INVITATION_EXPIRY_SECONDS:3600,userInvitationsService:()=>({list:mocks.list})}))

describe('Platform invitation privacy',()=>{
    it.each([['owner',PlatformRole.ADMIN,200],['member',PlatformRole.MEMBER,403],['operator',PlatformRole.OPERATOR,403],['another-admin',PlatformRole.ADMIN,403]])('limits listing for %s',async(id,role,status)=>{
        const app=Fastify()
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)
        app.decorateRequest('principal')
        app.addHook('preHandler',async request=>{request.principal={id,type:PrincipalType.USER,platform:{id:'platform-1'},tokenVersion:'test'}})
        app.setErrorHandler((error,_request,reply)=>{reply.code(error instanceof ActivepiecesError && error.error.code===ErrorCode.AUTHORIZATION?403:500).send({error:'Request rejected'})})
        mocks.user.mockResolvedValue({id,platformId:'platform-1',platformRole:role})
        mocks.platform.mockResolvedValue({id:'platform-1',ownerId:'owner'})
        mocks.list.mockResolvedValue({data:[],next:null,previous:null})
        await app.register(invitationModule)
        const response=await app.inject('/v1/user-invitations?type=PLATFORM')
        expect(response.statusCode).toBe(status)
        await app.close()
    })
})
