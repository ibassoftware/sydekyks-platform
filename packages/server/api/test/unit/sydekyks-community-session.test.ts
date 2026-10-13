import { PlatformRole, PrincipalType, UserStatus } from '@activepieces/shared'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessTokenManager } from '../../src/app/authentication/lib/access-token-manager'

const services = vi.hoisted(() => ({ decode: vi.fn(), user: vi.fn(), identity: vi.fn(), updatePlatform: vi.fn() }))
vi.mock('../../src/app/helper/jwt-utils', () => ({ jwtUtils: { getJwtSecret: async () => 'synthetic-test-secret', decodeAndVerify: services.decode } }))
vi.mock('../../src/app/user/user-service', () => ({ userService: () => ({ getOneOrFail: services.user }) }))
vi.mock('../../src/app/authentication/user-identity/user-identity-service', () => ({ userIdentityService: () => ({ getOneOrFail: services.identity, updateLastLoggedInPlatformId: services.updatePlatform }) }))
vi.mock('../../src/app/helper/system/system', () => ({ system: {} }))

const principal = { id: 'user-1', type: PrincipalType.USER, platform: { id: 'platform-1' }, tokenVersion: 'session-1' }
const user = { id: principal.id, identityId: 'identity-1', platformId: 'platform-1', platformRole: PlatformRole.ADMIN, status: UserStatus.ACTIVE }
const identity = { id: user.identityId, verified: true, tokenVersion: 'session-1', lastLoggedInPlatformId: 'platform-1' }
const log = Fastify({ logger: false }).log

beforeEach(() => {
    services.decode.mockReset().mockResolvedValue(principal)
    services.user.mockReset().mockResolvedValue(user)
    services.identity.mockReset().mockResolvedValue(identity)
    services.updatePlatform.mockReset()
})

describe('current tenant session validation', () => {
    it('accepts an active current tenant session', async () => {
        await expect(accessTokenManager(log).verifyPrincipal('synthetic-token')).resolves.toEqual(principal)
    })
    it('rejects a valid signed token after the user changes platform', async () => {
        services.user.mockResolvedValue({ ...user, platformId: 'platform-2' })
        await expect(accessTokenManager(log).verifyPrincipal('synthetic-token')).rejects.toThrow()
        expect(services.updatePlatform).not.toHaveBeenCalled()
    })
    it('rejects a detached or deactivated administrator', async () => {
        services.user.mockResolvedValue({ ...user, platformId: null })
        await expect(accessTokenManager(log).verifyPrincipal('synthetic-token')).rejects.toThrow()
        services.user.mockResolvedValue({ ...user, status: UserStatus.INACTIVE })
        await expect(accessTokenManager(log).verifyPrincipal('synthetic-token')).rejects.toThrow()
    })
    it('rejects a rotated session or an unverified identity', async () => {
        services.identity.mockResolvedValue({ ...identity, tokenVersion: 'session-2' })
        await expect(accessTokenManager(log).verifyPrincipal('synthetic-token')).rejects.toThrow()
        services.identity.mockResolvedValue({ ...identity, verified: false })
        await expect(accessTokenManager(log).verifyPrincipal('synthetic-token')).rejects.toThrow()
    })
})
