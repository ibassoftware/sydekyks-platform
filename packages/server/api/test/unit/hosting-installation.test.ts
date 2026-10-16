import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataSource, EntitySchema } from 'typeorm'
import { PGliteDriver } from 'typeorm-pglite'
import { FlagEntity } from '../../src/app/flags/flag.entity'
import { hostingInstallation, INSTALLATION_MODE_FLAG_ID } from '../../src/app/hosting/hosting-installation'

const dataSource = new DataSource({
    type: 'postgres',
    driver: new PGliteDriver().driver,
    entities: [FlagEntity, new EntitySchema({ name: 'platform', columns: { id: { type: String, primary: true } } })],
    synchronize: true,
})

beforeAll(async () => { await dataSource.initialize() })
afterAll(async () => { await dataSource.destroy() })
beforeEach(async () => {
    await dataSource.getRepository(FlagEntity).clear()
    await dataSource.getRepository('platform').clear()
})

describe('persistent installation service mode', () => {
    it('adds only an internal marker to an existing free installation', async () => {
        await dataSource.getRepository('platform').insert({ id: 'existing-customer' })
        await hostingInstallation.verify({ dataSource, mode: 'self_hosted' })
        expect(await dataSource.getRepository('platform').count()).toBe(1)
        expect((await dataSource.getRepository(FlagEntity).findOneByOrFail({ id: INSTALLATION_MODE_FLAG_ID })).value).toEqual({ schemaVersion: 1, serviceMode: 'self_hosted' })
    })

    it('never converts an existing unmarked customer installation to hosting', async () => {
        await dataSource.getRepository('platform').insert({ id: 'existing-customer' })
        await expect(hostingInstallation.verify({ dataSource, mode: 'hosted' })).rejects.toThrow('cannot be converted')
        expect(await dataSource.getRepository(FlagEntity).count()).toBe(0)
    })

    it('does not overwrite a latched hosted mode when configuration is lost', async () => {
        await hostingInstallation.verify({ dataSource, mode: 'hosted' })
        await expect(hostingInstallation.verify({ dataSource, mode: 'self_hosted' })).rejects.toThrow('does not match')
        expect((await dataSource.getRepository(FlagEntity).findOneByOrFail({ id: INSTALLATION_MODE_FLAG_ID })).value).toEqual({ schemaVersion: 1, serviceMode: 'hosted' })
    })

    it('preserves unrelated legacy flag records and accepts a repeated same-mode boot', async () => {
        await dataSource.getRepository(FlagEntity).insert({ id: 'SYDEKYKS_LICENSE_V1', value: { expired: true } })
        await hostingInstallation.verify({ dataSource, mode: 'self_hosted' })
        const first = await dataSource.getRepository(FlagEntity).findOneByOrFail({ id: INSTALLATION_MODE_FLAG_ID })
        await hostingInstallation.verify({ dataSource, mode: 'self_hosted' })
        expect(await dataSource.getRepository(FlagEntity).findOneByOrFail({ id: INSTALLATION_MODE_FLAG_ID })).toEqual(first)
        expect(await dataSource.getRepository(FlagEntity).count()).toBe(2)
    })

    it.each([null, {}, { schemaVersion: 2, serviceMode: 'hosted' }, { schemaVersion: 1, serviceMode: 'unknown' }])('refuses corrupt marker %j', async (value) => {
        await dataSource.getRepository(FlagEntity).createQueryBuilder().insert().values({
            id: INSTALLATION_MODE_FLAG_ID,
            value: value === null ? () => "'null'::jsonb" : value,
        }).execute()
        await expect(hostingInstallation.verify({ dataSource, mode: 'self_hosted' })).rejects.toThrow('marker is invalid')
    })
})
