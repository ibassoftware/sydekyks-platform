import { hostingCatalog, UserStatus } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { ProjectEntity } from '../project/project-entity'
import { UserEntity } from '../user/user-entity'
import { HostingInvitationEntity } from './hosting-entities'

export async function hostingResourceUsage(manager: EntityManager, platformId: string, now: Date) {
    const invitations = await manager.getRepository(HostingInvitationEntity).findBy({ platformId, status: 'pending' })
    const pending = invitations.filter(value => value.expiresAt > now)
    const users = await manager.getRepository(UserEntity).countBy({ platformId, status: UserStatus.ACTIVE })
    const projects = await manager.getRepository(ProjectEntity).countBy({ platformId })
    return { users, projects, pendingUsers: pending.length, pendingProjects: pending.reduce((sum, value) => sum + value.projectUnits, 0) }
}
export async function hostingResourceFits(manager: EntityManager, platformId: string, planId: 'starter' | 'team', now: Date): Promise<boolean> {
    const plan = hostingCatalog.getPlan({ planId })
    const usage = await hostingResourceUsage(manager, platformId, now)
    return usage.users + usage.pendingUsers <= plan.users && usage.projects + usage.pendingProjects <= plan.projects
}
