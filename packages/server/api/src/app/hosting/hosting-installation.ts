import { ServiceMode } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { z } from 'zod'
import { FlagEntity } from '../flags/flag.entity'

async function verify({ dataSource, mode }: VerifyInstallationParams): Promise<void> {
    await dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(FlagEntity)
        const existing = await repo.findOneBy({ id: INSTALLATION_MODE_FLAG_ID })
        if (existing) {
            assertMarker({ value: existing.value, mode })
            return
        }
        if (mode === 'hosted' && await manager.getRepository('platform').count() > 0) {
            throw new Error('An existing unmarked installation cannot be converted to hosted mode during startup')
        }
        await repo.createQueryBuilder().insert().values({
            id: INSTALLATION_MODE_FLAG_ID,
            value: { schemaVersion: 1, serviceMode: mode },
        }).orIgnore().execute()
        const marker = await repo.findOneByOrFail({ id: INSTALLATION_MODE_FLAG_ID })
        assertMarker({ value: marker.value, mode })
    })
}

function assertMarker({ value, mode }: { value: unknown, mode: ServiceMode }): void {
    const parsed = InstallationMarker.safeParse(value)
    if (!parsed.success) throw new Error('The installation service mode marker is invalid; startup refused')
    if (parsed.data.serviceMode !== mode) throw new Error('AP_SERVICE_MODE does not match the installation service mode; startup refused')
}

const InstallationMarker = z.object({ schemaVersion: z.literal(1), serviceMode: ServiceMode })
export const INSTALLATION_MODE_FLAG_ID = 'SYDEKYKS_HOST_MODE'
export const hostingInstallation = { verify }

type VerifyInstallationParams = {
    dataSource: DataSource
    mode: ServiceMode
}
