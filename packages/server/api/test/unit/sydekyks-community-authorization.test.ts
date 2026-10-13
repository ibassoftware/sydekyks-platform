import { Permission } from '@activepieces/core-utils'
import { EnginePrincipal, PlatformRole, PrincipalType, ProjectType, UserPrincipal, UserStatus } from '@activepieces/shared'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticateOrThrow } from '../../src/app/core/security/v2/authn/authenticate'
import { authorizeOrThrow } from '../../src/app/core/security/v2/authz/authorize'
import { AuthorizationRouteSecurity } from '../../src/app/core/security/authorization/authorization'
import { AuthorizationType, RouteKind } from '../../src/app/core/security/authorization/common'
import { resolveMcpPermissionChecker } from '../../src/app/mcp/mcp-permissions'
import { communityAuthorization } from '../../src/app/sydekyks-community/project-access'

const services = vi.hoisted(() => ({ project: vi.fn(), user: vi.fn(), verifyPrincipal: vi.fn() }))
vi.mock('../../src/app/project/project-service', () => ({ projectService: () => ({ getOne: services.project }) }))
vi.mock('../../src/app/user/user-service', () => ({ userService: () => ({ get: services.user, getOneOrFail: services.user }) }))
vi.mock('../../src/app/authentication/lib/access-token-manager', () => ({ accessTokenManager: () => ({ verifyPrincipal: services.verifyPrincipal }) }))
vi.mock('../../src/app/authentication/user-identity/user-identity-service', () => ({ userIdentityService: () => ({ getOneOrFail: vi.fn() }) }))

const log = Fastify({ logger: false }).log
const user = { id: 'user-1', platformId: 'platform-1', platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE }
const project = { id: 'project-1', platformId: 'platform-1', ownerId: user.id, type: ProjectType.PERSONAL }
const principal: UserPrincipal = { id: user.id, type: PrincipalType.USER, platform: { id: user.platformId }, tokenVersion: 'synthetic-session' }
const security: AuthorizationRouteSecurity = {
    kind: RouteKind.AUTHENTICATED,
    authorization: { type: AuthorizationType.PLATFORM, allowedPrincipals: [PrincipalType.USER], adminOnly: true },
}

beforeEach(() => {
    services.project.mockReset().mockResolvedValue(project)
    services.user.mockReset().mockResolvedValue(user)
    services.verifyPrincipal.mockReset().mockResolvedValue(principal)
})

describe('independent authorization adapters', () => {
    it('limits platform engine requests to the signed tenant and project', async () => {
        const engine: EnginePrincipal = { id: 'admission-1', type: PrincipalType.ENGINE, projectId: project.id, platform: { id: project.platformId } }
        const engineRoute: AuthorizationRouteSecurity = { kind: RouteKind.AUTHENTICATED, authorization: { type: AuthorizationType.PLATFORM, allowedPrincipals: [PrincipalType.ENGINE], adminOnly: false } }
        await expect(authorizeOrThrow(engine, engineRoute, log)).resolves.toBeUndefined()
        services.project.mockResolvedValue({ ...project, platformId: 'another-platform' })
        await expect(authorizeOrThrow(engine, engineRoute, log)).rejects.toThrow()
    })
    it('never grants platform administration to an engine principal', async () => {
        const engine: EnginePrincipal = { id: user.id, type: PrincipalType.ENGINE, projectId: project.id, platform: { id: project.platformId } }
        services.user.mockResolvedValue({ ...user, platformRole: PlatformRole.ADMIN })
        const engineRoute: AuthorizationRouteSecurity = { kind: RouteKind.AUTHENTICATED, authorization: { type: AuthorizationType.PLATFORM, allowedPrincipals: [PrincipalType.ENGINE], adminOnly: true } }
        await expect(authorizeOrThrow(engine, engineRoute, log)).rejects.toThrow()
    })

    it('resolves project ownership from current stored records', async () => {
        await expect(communityAuthorization.assertProjectAccess({ principal, projectId: project.id, permission: Permission.WRITE_FLOW, log })).resolves.toBeUndefined()
        services.user.mockResolvedValue({ ...user, platformId: 'another-platform' })
        await expect(communityAuthorization.assertProjectAccess({ principal, projectId: project.id, permission: Permission.WRITE_FLOW, log })).rejects.toThrow()
    })
    it('does not turn an unspecified permission into read-only access', async () => {
        services.project.mockResolvedValue({ ...project, type: ProjectType.TEAM, ownerId: 'another-user' })
        services.user.mockResolvedValue({ ...user, platformRole: PlatformRole.OPERATOR })
        await expect(communityAuthorization.assertProjectAccess({ principal, projectId: project.id, permission: Permission.READ_FLOW, log })).resolves.toBeUndefined()
        await expect(communityAuthorization.assertProjectAccess({ principal, projectId: project.id, log })).rejects.toThrow()
        await expect(communityAuthorization.assertProjectAccess({ principal, projectId: project.id, permission: Permission.WRITE_FLOW, log })).rejects.toThrow()
    })
    it('rejects another platform when computing socket permissions', async () => {
        const permissions = await communityAuthorization.getUserPermissions({ userId: user.id, platformId: 'another-platform', projectId: project.id, log })
        expect(permissions.size).toBe(0)
    })
    it('rejects inactive users for live permissions', async () => {
        services.user.mockResolvedValue({ ...user, status: UserStatus.INACTIVE })
        const permissions = await communityAuthorization.getUserPermissions({ userId: user.id, projectId: project.id, log })
        expect(permissions.size).toBe(0)
    })
    it('keeps MCP reads available to operators but blocks explicit and unannotated writes', async () => {
        services.project.mockResolvedValue({ ...project, type: ProjectType.TEAM, ownerId: 'another-user' })
        services.user.mockResolvedValue({ ...user, platformRole: PlatformRole.OPERATOR })
        const checker = await resolveMcpPermissionChecker({ userId: user.id, projectId: project.id, log })
        expect(checker.check(Permission.READ_FLOW, 'Read flows')).toBeNull()
        expect(checker.check(Permission.WRITE_FLOW, 'Change flows')?.isError).toBe(true)
        expect(checker.check(undefined, 'Unannotated operation')?.isError).toBe(true)
    })
    it('does not execute a denied MCP operation', async () => {
        services.project.mockResolvedValue({ ...project, platformId: 'another-platform' })
        const checker = await resolveMcpPermissionChecker({ userId: user.id, projectId: project.id, log })
        const execute = vi.fn()
        const wrapped = checker.wrapExecute({ execute, permission: Permission.WRITE_FLOW, toolTitle: 'Change flows' })
        const result = await wrapped({})
        expect(result.isError).toBe(true)
        expect(execute).not.toHaveBeenCalled()
    })
    it('rejects missing projects rather than inferring access', async () => {
        services.project.mockResolvedValue(null)
        await expect(communityAuthorization.assertProjectAccess({ principal, projectId: project.id, log })).rejects.toThrow()
    })
    it('rejects native service API keys without consulting the removed implementation', async () => {
        await expect(authenticateOrThrow(log, 'Bearer sk-example')).rejects.toThrow()
        expect(services.verifyPrincipal).not.toHaveBeenCalled()
    })
    it('rejects signed service principals in the permitted composition', async () => {
        services.verifyPrincipal.mockResolvedValue({ id: 'service-1', type: PrincipalType.SERVICE, platform: { id: user.platformId } })
        await expect(authenticateOrThrow(log, 'Bearer signed-token')).rejects.toThrow()
    })
    it('retains signed user authentication', async () => {
        await expect(authenticateOrThrow(log, 'Bearer signed-token')).resolves.toEqual(principal)
    })
    it('rejects platform administration with stale tenant claims', async () => {
        services.user.mockResolvedValue({ ...user, platformRole: PlatformRole.ADMIN, platformId: 'another-platform' })
        await expect(authorizeOrThrow(principal, security, log)).rejects.toThrow()
    })
    it('requires a current administrator for platform administration', async () => {
        await expect(authorizeOrThrow(principal, security, log)).rejects.toThrow()
        services.user.mockResolvedValue({ ...user, platformRole: PlatformRole.ADMIN })
        await expect(authorizeOrThrow(principal, security, log)).resolves.toBeUndefined()
    })
})
