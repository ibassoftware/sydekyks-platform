import { randomBytes } from 'node:crypto'
import { ServiceMode } from '@activepieces/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataSource, EntitySchema } from 'typeorm'
import { FlagEntity } from '../../../../src/app/flags/flag.entity'
import { hostingInstallation, INSTALLATION_MODE_FLAG_ID } from '../../../../src/app/hosting/hosting-installation'

const schema = `hosting_foundation_${randomBytes(6).toString('hex')}`
const dataSource = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: Number(process.env['HOSTING_TEST_POSTGRES_PORT'] ?? '55439'),
    username: process.env['HOSTING_TEST_POSTGRES_USER'] ?? 'hosting_tests',
    password: process.env['HOSTING_TEST_POSTGRES_PASSWORD'] ?? 'disposable-only',
    database: process.env['HOSTING_TEST_POSTGRES_DATABASE'] ?? 'hosting_tests',
    schema,
    entities: [FlagEntity, new EntitySchema({ name: 'platform', columns: { id: { type: String, primary: true } } })],
    synchronize: false,
})

beforeAll(async () => {
    await dataSource.initialize()
    await dataSource.createQueryRunner().createSchema(schema, true)
    await dataSource.synchronize()
})
afterAll(async () => {
    if (!dataSource.isInitialized) return
    await dataSource.query(`DROP SCHEMA "${schema}" CASCADE`)
    await dataSource.destroy()
})
beforeEach(async () => { await dataSource.getRepository(FlagEntity).clear() })

describe('PostgreSQL installation mode races', () => {
    it('concurrent same-mode startups create exactly one persistent marker', async () => {
        await Promise.all(Array.from({ length: 8 }, () => hostingInstallation.verify({ dataSource, mode: 'self_hosted' })))
        expect(await dataSource.getRepository(FlagEntity).count()).toBe(1)
    })

    it('competing service modes cannot overwrite the first committed marker', async () => {
        const modes: ServiceMode[] = ['self_hosted', 'hosted', 'self_hosted', 'hosted', 'self_hosted', 'hosted']
        const results = await Promise.allSettled(modes.map(mode => hostingInstallation.verify({ dataSource, mode })))
        const marker = await dataSource.getRepository(FlagEntity).findOneByOrFail({ id: INSTALLATION_MODE_FLAG_ID })
        expect(await dataSource.getRepository(FlagEntity).count()).toBe(1)
        for (const [index, result] of results.entries()) {
            expect(result.status).toBe(marker.value && typeof marker.value === 'object' && 'serviceMode' in marker.value && marker.value.serviceMode === modes[index] ? 'fulfilled' : 'rejected')
        }
    })
})
