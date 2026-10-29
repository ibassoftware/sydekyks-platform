import { ProjectType } from '@activepieces/shared'
import { DataSource, EntityManager, Not } from 'typeorm'
import { ProjectEntity } from '../project/project-entity'
import { HostingAccountEntity, HostingInvitationEntity } from './hosting-entities'
import { hostingFail, hostingTransactions } from './hosting-transactions'

export async function isHostedSharedProject(manager: EntityManager, platformId: string, projectId: string): Promise<boolean> {
    return manager.getRepository(HostingAccountEntity).existsBy({ id: platformId, initialProjectId: projectId })
}

// Preserve the original project and all its content. Ambiguous older tenants
// need an explicit consolidation plan; never guess which content to discard.
export async function initializeHostedSharedProjects(dataSource: DataSource): Promise<void> {
    await dataSource.transaction(async manager => {
        const accounts = await manager.getRepository(HostingAccountEntity).createQueryBuilder('account').setLock('pessimistic_write').getMany()
        for (const account of accounts) {
            const projects = await manager.getRepository(ProjectEntity).find({ where: { platformId: account.id }, withDeleted: true })
            if (projects.length !== 1 || projects[0].id !== account.initialProjectId || projects[0].deleted) hostingFail('HOSTING_SHARED_CENTER_CONSOLIDATION_REQUIRED')
        }
        for (const account of accounts) {
            const project = await manager.getRepository(ProjectEntity).findOneByOrFail({ id: account.initialProjectId, platformId: account.id })
            if (project.type !== ProjectType.TEAM) {
                await manager.getRepository(ProjectEntity).update({ id: project.id }, { type: ProjectType.TEAM })
                await hostingTransactions.event({ manager, platformId: account.id, event: 'project.shared', payload: { projectId: project.id } })
            }
            await manager.getRepository(HostingInvitationEntity).update({ platformId: account.id, status: 'pending', projectUnits: Not(0) }, { projectUnits: 0 })
        }
    })
}
