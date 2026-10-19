import { Readable } from 'node:stream'
import { File, FileLocation, FileType, FlowRunStatus, HostedPlanId } from '@activepieces/shared'
import { DataSource, EntityManager, EntitySchema } from 'typeorm'
import { FileEntity } from '../file/file.entity'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { HostingAccountEntity } from './hosting-entities'
import { hostingFail } from './hosting-transactions'

export const HostingStorageLockEntity = new EntitySchema<{ id: string }>({ name: 'hosting_storage_lock', columns: { id: { type: String, primary: true } } })
const MiB = 1024 * 1024
const defaults = { trial: 64 * MiB, training: 256 * MiB, assessment: 256 * MiB, starter: 1024 * MiB, team: 4096 * MiB, global: 8192 * MiB }
export function hostedStorageLimits(): typeof defaults {
    const raw = system.get(AppSystemProp.HOSTED_STORAGE_LIMITS_JSON)
    const limits = { ...defaults }
    if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid hosted storage limits')
        for (const [key, value] of Object.entries(parsed)) {
            if (!(key in defaults) || !Number.isSafeInteger(value) || Number(value) < MiB || Number(value) > 1024 ** 4) throw new Error('Invalid hosted storage limit')
            limits[key as keyof typeof defaults] = Number(value)
        }
    }
    return limits
}
export async function hostedFileBytes(data: Buffer | Readable | null): Promise<Buffer> {
    const maximum = system.getNumberOrThrow(AppSystemProp.MAX_FILE_SIZE_MB) * MiB
    if (data === null) hostingFail('HOSTING_FILE_DATA_REQUIRED')
    if (Buffer.isBuffer(data)) {
        if (data.length > maximum) hostingFail('HOSTING_FILE_TOO_LARGE')
        return data
    }
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of data) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += bytes.length
        if (length > maximum) {
            data.destroy(); hostingFail('HOSTING_FILE_TOO_LARGE') 
        }
        chunks.push(bytes)
    }
    return Buffer.concat(chunks, length)
}
async function lockStorage(manager: EntityManager): Promise<void> {
    await manager.getRepository(HostingStorageLockEntity).createQueryBuilder().insert().values({ id: 'global' }).orIgnore().execute()
    await manager.getRepository(HostingStorageLockEntity).findOneOrFail({ where: { id: 'global' }, lock: { mode: 'pessimistic_write' } })
}
export async function hostedStorageUsage(manager: EntityManager, platformId: string | null) {
    const [row]: { own: string, total: string }[] = await manager.query('SELECT COALESCE(SUM(GREATEST(COALESCE(size,0),COALESCE(octet_length(data),0))) FILTER (WHERE "platformId"=$1),0)::text own, COALESCE(SUM(GREATEST(COALESCE(size,0),COALESCE(octet_length(data),0))),0)::text total FROM file', [platformId])
    return { own: Number(row.own), total: Number(row.total) }
}
async function ownLimit(manager: EntityManager, platformId: string): Promise<number> {
    const account = await manager.getRepository(HostingAccountEntity).findOneBy({ id: platformId })
    if (!account) hostingFail('HOSTING_STORAGE_SCOPE_UNAVAILABLE')
    return hostedStorageLimits()[account.planId as HostedPlanId]
}
export async function assertHostedStorageAdmission(manager: EntityManager, platformId: string): Promise<void> {
    await lockStorage(manager)
    const usage = await hostedStorageUsage(manager, platformId)
    if (usage.total >= hostedStorageLimits().global) hostingFail('HOSTING_STORAGE_UNAVAILABLE')
    if (usage.own >= await ownLimit(manager, platformId)) hostingFail('HOSTING_STORAGE_LIMIT')
}
export async function saveHostedFile(dataSource: DataSource, file: Omit<File, 'location' | 'data'>, data: Buffer): Promise<File> {
    return dataSource.transaction(async manager => {
        await lockStorage(manager)
        let platformId = file.platformId ?? null
        if (file.projectId) {
            const [project]: { platformId: string }[] = await manager.query('SELECT "platformId" FROM project WHERE id=$1', [file.projectId])
            if (!project || (platformId && platformId !== project.platformId)) hostingFail('HOSTING_STORAGE_SCOPE_UNAVAILABLE')
            platformId = project.platformId
        }
        const existing = await manager.getRepository(FileEntity).findOneBy({ id: file.id })
        if (existing && (existing.platformId !== platformId || (existing.projectId ?? null) !== (file.projectId ?? null) || existing.type !== file.type)) hostingFail('HOSTING_STORAGE_SCOPE_CONFLICT')
        const oldBytes = existing ? Math.max(existing.size ?? 0, existing.data?.length ?? 0) : 0
        const delta = data.length - oldBytes, usage = await hostedStorageUsage(manager, platformId)
        if (delta > 0 && usage.total + delta > hostedStorageLimits().global) hostingFail('HOSTING_STORAGE_UNAVAILABLE')
        if (delta > 0 && platformId && usage.own + delta > await ownLimit(manager, platformId)) hostingFail('HOSTING_STORAGE_LIMIT')
        return manager.getRepository(FileEntity).save({ ...file, created: existing?.created ?? file.created, platformId, size: data.length, location: FileLocation.DB, data, s3Key: null })
    })
}
const expiring = [FileType.FLOW_RUN_LOG, FileType.FLOW_RUN_LOG_SLICE, FileType.FLOW_STEP_FILE, FileType.TRIGGER_PAYLOAD, FileType.TRIGGER_EVENT_FILE, FileType.WEBHOOK_PAYLOAD, FileType.MCP_CALL_PAYLOAD]
const terminal = [FlowRunStatus.SUCCEEDED, FlowRunStatus.FAILED, FlowRunStatus.QUOTA_EXCEEDED, FlowRunStatus.INTERNAL_ERROR, FlowRunStatus.MEMORY_LIMIT_EXCEEDED, FlowRunStatus.TIMEOUT, FlowRunStatus.CANCELED, FlowRunStatus.LOG_SIZE_EXCEEDED]
export async function cleanupHostedFiles(dataSource: DataSource, requestedTypes: FileType[], retentionDays: number): Promise<number> {
    const types = requestedTypes.filter(type => expiring.includes(type))
    if (!types.length) return 0
    return dataSource.transaction(async manager => {
        await lockStorage(manager)
        // Conservatively retain every file in a project with an unsettled root or
        // nonterminal run. Durable assets and unscoped files are never swept.
        const removed: { id: string }[] = await manager.query(`DELETE FROM file WHERE id IN (
            SELECT f.id FROM file f JOIN project p ON p.id=f."projectId" AND p."platformId"=f."platformId"
            WHERE f.type=ANY($1::varchar[]) AND f.location='DB'
            AND f.created < CURRENT_TIMESTAMP - ($2::int * interval '1 day')
            AND NOT EXISTS (SELECT 1 FROM hosting_reservation r WHERE r."projectId"=f."projectId" AND r.kind='execution' AND r.state IN ('reserved','running','paused','uncertain'))
            AND NOT EXISTS (SELECT 1 FROM flow_run r WHERE r."projectId"=f."projectId" AND r.status <> ALL($3::varchar[]))
            ORDER BY f.created ASC,f.id ASC LIMIT 4000
        ) RETURNING id`, [types, retentionDays, terminal])
        return removed.length
    })
}
