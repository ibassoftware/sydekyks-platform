import { Permission, PlatformRole, PrincipalType, ProjectType, UserStatus, WebsocketServerEvent } from '@activepieces/shared'
import { describe, expect, it } from 'vitest'
import { communityProjectAccess } from '../../src/app/sydekyks-community/project-access-policy'

const project = { id: 'project-1', platformId: 'platform-1', ownerId: 'user-1', type: ProjectType.PERSONAL }
const principal = { id: 'user-1', type: PrincipalType.USER, platformId: 'platform-1' }
const user = { id: 'user-1', platformId: 'platform-1', platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE }

function allowed(overrides: Partial<Parameters<typeof communityProjectAccess.canAccessProject>[0]> = {}) {
    return communityProjectAccess.canAccessProject({ principal, project, user, write: false, ...overrides })
}

describe('independent Community workspace authorization', () => {
    it('allows the active owner to read and write', () => {
        expect(allowed()).toBe(true)
        expect(allowed({ write: true })).toBe(true)
    })
    it('rejects another platform even for an administrator', () => {
        expect(allowed({ principal: { ...principal, platformId: 'platform-2' }, user: { ...user, platformRole: PlatformRole.ADMIN } })).toBe(false)
    })
    it('rejects a principal and user platform mismatch', () => {
        expect(allowed({ user: { ...user, platformId: 'platform-2' } })).toBe(false)
    })
    it('rejects a deleted project', () => {
        expect(allowed({ project: { ...project, deleted: '2026-10-07T00:00:00Z' } })).toBe(false)
    })
    it('rejects an inactive user', () => {
        expect(allowed({ user: { ...user, status: UserStatus.INACTIVE } })).toBe(false)
    })
    it('rejects a mismatched user identity', () => {
        expect(allowed({ user: { ...user, id: 'user-2' } })).toBe(false)
    })
    it('does not grant access to another personal project', () => {
        expect(allowed({ project: { ...project, ownerId: 'user-2' }, user: { ...user, platformRole: PlatformRole.ADMIN } })).toBe(false)
    })
    it('allows platform administrators to manage a team project', () => {
        expect(allowed({ project: { ...project, type: ProjectType.TEAM, ownerId: 'user-2' }, user: { ...user, platformRole: PlatformRole.ADMIN }, write: true })).toBe(true)
    })
    it('allows an operator to read a team project but rejects writes', () => {
        const shared = { project: { ...project, type: ProjectType.TEAM, ownerId: 'user-2' }, user: { ...user, platformRole: PlatformRole.OPERATOR } }
        expect(allowed(shared)).toBe(true)
        expect(allowed({ ...shared, write: true })).toBe(false)
    })
    it('does not infer a team membership for an ordinary member', () => {
        expect(allowed({ project: { ...project, type: ProjectType.TEAM, ownerId: 'user-2' } })).toBe(false)
    })
    it('limits engine access to its token project', () => {
        expect(allowed({ principal: { ...principal, type: PrincipalType.ENGINE, projectId: project.id }, user: undefined })).toBe(true)
        expect(allowed({ principal: { ...principal, type: PrincipalType.ENGINE, projectId: 'project-2' }, user: undefined })).toBe(false)
    })
    it('rejects service, worker and unknown principals', () => {
        for (const type of [PrincipalType.SERVICE, PrincipalType.WORKER, PrincipalType.UNKNOWN]) expect(allowed({ principal: { ...principal, type } })).toBe(false)
    })
})

describe('socket event permissions', () => {
    const readOnly = new Set([Permission.READ_FLOW, Permission.READ_MCP])
    it('blocks test runs and unannotated mutation events for read-only users', () => {
        expect(communityProjectAccess.canHandleSocketEvent({ event: WebsocketServerEvent.TEST_FLOW_RUN, permissions: readOnly })).toBe(false)
        expect(communityProjectAccess.canHandleSocketEvent({ event: WebsocketServerEvent.TEST_FLOW_RUN, permission: Permission.WRITE_RUN, permissions: readOnly })).toBe(false)
        expect(communityProjectAccess.canHandleSocketEvent({ event: WebsocketServerEvent.LOCK_RESOURCE, permissions: readOnly })).toBe(false)
    })
    it('allows presence and release of the current user lock for read-only users', () => {
        for (const event of [WebsocketServerEvent.JOIN_PRESENCE, WebsocketServerEvent.LEAVE_PRESENCE, WebsocketServerEvent.UNLOCK_RESOURCE]) {
            expect(communityProjectAccess.canHandleSocketEvent({ event, permissions: readOnly })).toBe(true)
        }
    })
    it('requires the explicit execution permission for a test run', () => {
        expect(communityProjectAccess.canHandleSocketEvent({ event: WebsocketServerEvent.TEST_FLOW_RUN, permission: Permission.WRITE_RUN, permissions: new Set([Permission.WRITE_FLOW]) })).toBe(false)
        expect(communityProjectAccess.canHandleSocketEvent({ event: WebsocketServerEvent.TEST_FLOW_RUN, permission: Permission.WRITE_RUN, permissions: new Set([Permission.WRITE_RUN]) })).toBe(true)
    })
    it('allows disconnect cleanup without a current role', () => {
        expect(communityProjectAccess.canHandleSocketEvent({ event: WebsocketServerEvent.DISCONNECT })).toBe(true)
    })
})
