import { ColorName, PlatformRole, PrincipalType, ProjectType, UserPrincipal, UserStatus } from '@activepieces/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { communityProjectManagement } from '../../src/app/sydekyks-community/project-management.service'
import { CommunityProjectCreate, CommunityProjectUpdate } from '../../src/app/sydekyks-community/project-requests'
import { system } from '../../src/app/helper/system/system'

const services = vi.hoisted(() => ({
    user: vi.fn(), project: vi.fn(), create: vi.fn(), update: vi.fn(), archive: vi.fn(), restore: vi.fn(),
    enabled: vi.fn(), triggers: vi.fn(), runs: vi.fn(),
}))
vi.mock('../../src/app/project/project-lifecycle', () => ({ projectLifecycle: { runWhileActive: ({ operation }: { operation: () => Promise<unknown> }) => operation() } }))
vi.mock('../../src/app/user/user-service', () => ({ userService: () => ({ get: services.user }) }))
vi.mock('../../src/app/project/project-service', () => ({
    projectService: () => ({ getOne: services.project, getOneOrThrow: services.project, create: services.create }),
    projectRepo: () => ({ findOneByOrFail: services.project, findOneOrFail: services.project, findOne: services.project,
        update: services.update, softDelete: services.archive, restore: services.restore }),
}))
vi.mock('../../src/app/flows/flow/flow.repo', () => ({ flowRepo: () => ({ countBy: services.enabled }) }))
vi.mock('../../src/app/core/db/repo-factory', () => ({
    repoFactory: (entity: { options: { name: string } }) => () => ({ countBy: entity.options.name === 'trigger_source' ? services.triggers : services.runs }),
}))
vi.mock('../../src/app/core/db/transaction', () => ({ transaction: (operation: (manager: undefined) => Promise<unknown>) => operation(undefined) }))

const principal: UserPrincipal = { id: 'creator', type: PrincipalType.USER, platform: { id: 'platform' } }
const user = { id: principal.id, platformId: 'platform', platformRole: PlatformRole.MEMBER, status: UserStatus.ACTIVE }
const project = { id: 'center', platformId: 'platform', ownerId: user.id, type: ProjectType.TEAM, displayName: 'QA', icon: { color: ColorName.BLUE } }
const service = communityProjectManagement(system.globalLogger())

beforeEach(() => {
    services.user.mockResolvedValue(user)
    services.project.mockResolvedValue(project)
    services.create.mockResolvedValue(project)
    services.enabled.mockResolvedValue(0)
    services.triggers.mockResolvedValue(0)
    services.runs.mockResolvedValue(0)
})
afterEach(() => vi.clearAllMocks())

describe('Command Center request contracts', () => {
    it('trims names and rejects whitespace-only or unsafe names', () => {
        expect(CommunityProjectCreate.parse({ displayName: ' Finance ' })).toEqual({ displayName: 'Finance' })
        expect(CommunityProjectCreate.safeParse({ displayName: '  ' }).success).toBe(false)
        expect(CommunityProjectCreate.safeParse({ displayName: '../other' }).success).toBe(false)
    })
    it('rejects spoofed ownership, platform, types, and deferred administration fields', () => {
        for (const extra of [{ ownerId: 'other' }, { platformId: 'other' }, { type: 'PERSONAL' },
            { plan: { activeFlowsLimit: 1 } }, { workerGroupId: 'worker' }, { sensitive: true }, { globalConnectionExternalIds: ['secret'] }]) {
            expect(CommunityProjectCreate.safeParse({ displayName: 'Finance', ...extra }).success).toBe(false)
            expect(CommunityProjectUpdate.safeParse({ displayName: 'Finance', ...extra }).success).toBe(false)
        }
    })
})

describe('creator-owned Command Center lifecycle', () => {
    it('creates centers for the authenticated active creator without a count quota', async () => {
        for (let index = 0; index < 3; index++) await service.create({ principal, request: { displayName: `Center ${index}` } })
        expect(services.create).toHaveBeenCalledTimes(3)
        expect(services.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: user.id, platformId: user.platformId, type: ProjectType.TEAM }))
    })
    it('rejects inactive or foreign-platform creators', async () => {
        services.user.mockResolvedValue({ ...user, status: UserStatus.INACTIVE })
        await expect(service.create({ principal, request: { displayName: 'Finance' } })).rejects.toThrow()
        services.user.mockResolvedValue({ ...user, platformId: 'foreign' })
        await expect(service.create({ principal, request: { displayName: 'Finance' } })).rejects.toThrow()
        expect(services.create).not.toHaveBeenCalled()
    })
    it('persists supported owner changes with a platform-scoped predicate', async () => {
        await service.update({ principal, projectId: project.id, request: { displayName: 'Renamed', icon: { color: ColorName.GREEN } } })
        expect(services.update).toHaveBeenCalledWith(expect.objectContaining({ id: project.id, platformId: user.platformId }),
            { displayName: 'Renamed', icon: { color: ColorName.GREEN } })
    })
    it('rejects a different ordinary owner and cross-platform projects', async () => {
        for (const other of [{ ...project, ownerId: 'other' }, { ...project, platformId: 'foreign' }]) {
            services.project.mockResolvedValue(other)
            await expect(service.update({ principal, projectId: project.id, request: { displayName: 'Renamed' } })).rejects.toThrow()
            await expect(service.archive({ principal, projectId: project.id })).rejects.toThrow()
        }
        expect(services.update).not.toHaveBeenCalled()
        expect(services.archive).not.toHaveBeenCalled()
    })
    it('allows an administrator to manage team centers while keeping operators read-only', async () => {
        services.project.mockResolvedValue({ ...project, ownerId: 'other' })
        services.user.mockResolvedValue({ ...user, platformRole: PlatformRole.ADMIN })
        await service.update({ principal, projectId: project.id, request: { displayName: 'Admin rename' } })
        services.user.mockResolvedValue({ ...user, platformRole: PlatformRole.OPERATOR })
        await expect(service.update({ principal, projectId: project.id, request: { displayName: 'Operator rename' } })).rejects.toThrow()
        expect(services.update).toHaveBeenCalledOnce()
    })
    it('protects Personal from rename and archive', async () => {
        services.project.mockResolvedValue({ ...project, type: ProjectType.PERSONAL })
        await expect(service.update({ principal, projectId: project.id, request: { displayName: 'Renamed' } })).rejects.toThrow()
        await expect(service.archive({ principal, projectId: project.id })).rejects.toThrow()
        expect(services.archive).not.toHaveBeenCalled()
    })
    it('rejects archive while flows, triggers, or unfinished runs can still execute', async () => {
        for (const busy of [services.enabled, services.triggers, services.runs]) {
            busy.mockResolvedValueOnce(1)
            await expect(service.archive({ principal, projectId: project.id })).rejects.toThrow()
        }
        expect(services.archive).not.toHaveBeenCalled()
    })
    it('archives safely without purging retained data and allows owner restoration', async () => {
        await service.archive({ principal, projectId: project.id })
        expect(services.archive).toHaveBeenCalledWith({ id: project.id, platformId: user.platformId })
        services.project.mockResolvedValue({ ...project, deleted: '2026-10-09' })
        await service.restore({ principal, projectId: project.id })
        expect(services.restore).toHaveBeenCalledWith({ id: project.id, platformId: user.platformId })
    })
    it('rejects unauthorized archive restoration', async () => {
        services.project.mockResolvedValue({ ...project, ownerId: 'other', deleted: '2026-10-09' })
        await expect(service.restore({ principal, projectId: project.id })).rejects.toThrow()
        expect(services.restore).not.toHaveBeenCalled()
    })
})
