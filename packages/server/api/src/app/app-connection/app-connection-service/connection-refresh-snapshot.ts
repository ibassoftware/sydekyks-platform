import { AppConnection, AppConnectionStatus } from '@activepieces/shared'
import { ArrayContains, FindOptionsWhere, Repository } from 'typeorm'
import { encryptUtils } from '../../helper/encryption'
import { hostingConfiguration } from '../../hosting/hosting-configuration'
import { hostingFail } from '../../hosting/hosting-transactions'
import { AppConnectionSchema } from '../app-connection.entity'

type RefreshSnapshot = { connection: AppConnectionSchema | null, updatedAt: string | null }

// PostgreSQL timestamps retain microseconds; JavaScript Dates do not. Read the
// exact revision beside the encrypted value in one statement, before dispatch.
export async function readConnectionRefreshSnapshot(repository: Repository<AppConnectionSchema>, where: FindOptionsWhere<AppConnectionSchema>): Promise<RefreshSnapshot> {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return { connection: await repository.findOneBy(where), updatedAt: null }
    const result = await repository.createQueryBuilder('connection').addSelect('"connection"."updated"::text', 'refreshUpdatedAt').where(where).getRawAndEntities()
    const connection = result.entities[0] ?? null
    const updatedAt: unknown = result.raw[0]?.refreshUpdatedAt
    if (connection && typeof updatedAt !== 'string') hostingFail('HOSTING_CONNECTION_REVISION_MISMATCH')
    return { connection, updatedAt: typeof updatedAt === 'string' ? updatedAt : null }
}

export async function persistConnectionRefresh(repository: Repository<AppConnectionSchema>, snapshot: RefreshSnapshot, refreshed: AppConnection, projectId: string): Promise<void> {
    const value = await encryptUtils.encryptObject(refreshed.value)
    if (hostingConfiguration.getServiceMode() !== 'hosted') {
        await repository.update(refreshed.id, { status: AppConnectionStatus.ACTIVE, value })
        return
    }
    const original = snapshot.connection
    if (!original || !snapshot.updatedAt) hostingFail('HOSTING_CONNECTION_REVISION_MISMATCH')
    // Keep the complete revision, encrypted-value and current project-grant
    // fences. Never overwrite a replacement or return stale credentials.
    const result = await repository.createQueryBuilder().update().set({ status: AppConnectionStatus.ACTIVE, value })
        .where({ id: original.id, platformId: original.platformId, projectIds: ArrayContains([projectId]) })
        .andWhere('updated = CAST(:originalUpdatedAt AS timestamptz)', { originalUpdatedAt: snapshot.updatedAt })
        .andWhere('value = CAST(:originalValue AS jsonb)', { originalValue: JSON.stringify(original.value) }).returning(['id']).execute()
    if (!Array.isArray(result.raw) || result.raw.length !== 1) hostingFail('HOSTING_CONNECTION_REVISION_MISMATCH')
}
