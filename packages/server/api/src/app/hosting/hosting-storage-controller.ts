import { PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { databaseConnection } from '../database/database-connection'
import { UserEntity } from '../user/user-entity'
import { assertHostingOperator } from './hosting-access-policy'
import { hostedStorageLimits, hostedStorageUsage } from './hosting-storage'
import { hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const hostingStorageController: FastifyPluginAsyncZod = async app => {
    app.get('/storage', { config: { security: securityAccess.unscoped([PrincipalType.USER]) } }, async (request, reply) => {
        void reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
        if (request.principal.type !== PrincipalType.USER) hostingFail('HOSTING_OPERATOR_REQUIRED')
        const principal = request.principal, dataSource = databaseConnection()
        return tx.run({ dataSource, fn: async manager => {
            const user = await manager.getRepository(UserEntity).findOneBy({ id: principal.id, platformId: principal.platform.id })
            if (!user) hostingFail('HOSTING_OPERATOR_REQUIRED')
            await assertHostingOperator({ manager, actor: { identityId: user.identityId, platformId: principal.platform.id, tokenVersion: principal.tokenVersion ?? null } })
            const usage = await hostedStorageUsage(manager, null)
            const [database]: { bytes: string }[] = await manager.query('SELECT pg_database_size(current_database())::text bytes')
            return { fileBytes: usage.total, fileLimitsBytes: hostedStorageLimits(), databaseBytes: Number(database.bytes), fileWarning: usage.total >= hostedStorageLimits().global * 0.8, scope: 'Database file quotas exclude database indexes, WAL, logs and backups; monitor host disk separately.' }
        } })
    })
}
