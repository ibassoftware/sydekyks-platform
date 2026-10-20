import { apId } from '@activepieces/core-utils'
import { hostingCatalog, PlatformRole, UserStatus } from '@activepieces/shared'
import { DataSource, EntityManager } from 'typeorm'
import { z } from 'zod'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { FlagEntity } from '../flags/flag.entity'
import { ProjectEntity } from '../project/project-entity'
import { UserEntity } from '../user/user-entity'
import { hasOperationalAccess, isOperationalUser } from './hosting-access-policy'
import { HostingAccount, HostingAccountEntity, HostingGrant, HostingLedgerEntity, HostingOutboxEntity, HostingReservation } from './hosting-entities'
import { INSTALLATION_MODE_FLAG_ID } from './hosting-installation'
import { loadSubscriptionContext, subscriptionAccountActive, subscriptionGrantActive } from './hosting-subscription-policy'

async function run<T>({ dataSource, manager: existing, fn }: { dataSource: DataSource, manager?: EntityManager, fn: (manager: EntityManager) => Promise<T> }): Promise<T> {
    const operation = async (manager: EntityManager): Promise<T> => {
        const flag = await manager.getRepository(FlagEntity).findOneBy({ id: INSTALLATION_MODE_FLAG_ID })
        if (!z.object({ schemaVersion: z.literal(1), serviceMode: z.literal('hosted') }).safeParse(flag?.value).success) hostingFail('HOSTED_INSTALLATION_REQUIRED')
        return fn(manager)
    }
    if (existing && (existing.connection !== dataSource || !existing.queryRunner?.isTransactionActive)) hostingFail('HOSTING_TRANSACTION_REQUIRED')
    return existing ? operation(existing) : dataSource.transaction(operation)
}

async function now(manager: EntityManager): Promise<Date> {
    const rows = await manager.query<{ now: Date }[]>('SELECT clock_timestamp() AS now')
    return rows[0].now
}

async function account({ manager, platformId }: { manager: EntityManager, platformId: string }): Promise<HostingAccount> {
    const value = await manager.getRepository(HostingAccountEntity).findOne({ where: { id: platformId }, lock: { mode: 'pessimistic_write' } })
    if (!value) hostingFail('HOSTING_ACCOUNT_NOT_FOUND')
    return { ...value, subscription: await loadSubscriptionContext(manager, value) }
}

async function member({ manager, actor, admin = false, projectId, write = false }: { manager: EntityManager, actor: HostingActor, admin?: boolean, projectId?: string, write?: boolean }) {
    const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ id: actor.identityId })
    const user = await manager.getRepository(UserEntity).findOneBy({ platformId: actor.platformId, identityId: actor.identityId, status: UserStatus.ACTIVE })
    if (!identity?.verified || (actor.tokenVersion !== undefined && (identity.tokenVersion ?? null) !== actor.tokenVersion) || !user || (admin && user.platformRole !== PlatformRole.ADMIN)) hostingFail('HOSTING_ACCESS_DENIED')
    const operational = isOperationalUser(user)
    const operationalAllowed = operational && await hasOperationalAccess({ manager, user })
    if (operational && !operationalAllowed) hostingFail('HOSTING_OPERATIONAL_ACCESS_DENIED')
    if (projectId) {
        const project = await manager.getRepository(ProjectEntity).findOneBy({ id: projectId, platformId: actor.platformId })
        if (!project || (project.type === 'PERSONAL' && project.ownerId !== user.id && !operationalAllowed)) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
        if (!operationalAllowed && project.ownerId !== user.id && user.platformRole !== PlatformRole.ADMIN && (write || user.platformRole !== PlatformRole.OPERATOR)) hostingFail('HOSTING_PROJECT_ACCESS_DENIED')
    }
    return user
}

function assertActive({ account: value, now: instant }: { account: HostingAccount, now: Date }): void {
    if (!(hostingCatalog.supportedVersions as readonly string[]).includes(value.catalogVersion)) hostingFail('HOSTING_CATALOG_UNAVAILABLE')
    if (!subscriptionAccountActive(value, instant)) hostingFail('HOSTING_ENTITLEMENT_EXPIRED')
}

function assertGrantActive({ grant, now: instant, account: owner }: { grant: HostingGrant, now: Date, account?: HostingAccount }): void {
    if (owner ? !subscriptionGrantActive(owner, grant, instant) : grant.revokedAt || grant.validFrom > instant || grant.validUntil <= instant) hostingFail('HOSTING_GRANT_EXPIRED')
}

async function entry({ manager, reservation, operation, amount, key }: { manager: EntityManager, reservation: HostingReservation, operation: 'reserve' | 'dispatch' | 'settle' | 'release' | 'uncertain' | 'revoke', amount: bigint, key?: string }): Promise<void> {
    await manager.getRepository(HostingLedgerEntity).insert({ id: apId(), platformId: reservation.platformId, grantId: reservation.grantId, reservationId: reservation.id, operation, key: key ?? `${operation}:${reservation.id}`, amount })
}

async function event({ manager, platformId, event, payload }: { manager: EntityManager, platformId: string, event: string, payload: Record<string, unknown> }): Promise<void> {
    await manager.getRepository(HostingOutboxEntity).save({ id: apId(), platformId, event, payload, processedAt: null })
}

export function hostingFail(reason: string): never {
    throw new HostingError(reason)
}

function assertKey(key: string): void {
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(key)) hostingFail('HOSTING_INVALID_ACCOUNTING_KEY')
}

function assertAmount(amount: bigint): void {
    if (typeof amount !== 'bigint' || amount <= 0n || amount > 10n ** 24n) hostingFail('HOSTING_INVALID_AMOUNT')
}

export class HostingError extends Error {}
export const hostingTransactions = { run, now, account, member, assertActive, assertGrantActive, entry, event, hostingFail, assertKey, assertAmount }
export type HostingActor = { identityId: string, platformId: string, tokenVersion?: string | null }
