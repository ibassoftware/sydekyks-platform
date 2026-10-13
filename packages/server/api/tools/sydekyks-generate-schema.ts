import { writeFileSync } from 'node:fs'
import { DataSource } from 'typeorm'
import { commonProperties } from '../src/app/database/database-connection'
import { system } from '../src/app/helper/system/system'
import { AppSystemProp } from '../src/app/helper/system/system-props'

async function generate(): Promise<void> {
    const source = new DataSource({ type: 'postgres', host: system.getOrThrow(AppSystemProp.POSTGRES_HOST), port: Number(system.getOrThrow(AppSystemProp.POSTGRES_PORT)), username: system.getOrThrow(AppSystemProp.POSTGRES_USERNAME), password: system.getOrThrow(AppSystemProp.POSTGRES_PASSWORD), database: system.getOrThrow(AppSystemProp.POSTGRES_DATABASE), ...commonProperties, synchronize: false, migrationsRun: false })
    await source.initialize()
    try {
        const sql = await source.driver.createSchemaBuilder().log()
        const schema = { up: ["CREATE EXTENSION IF NOT EXISTS vector", "CREATE COLLATION IF NOT EXISTS en_natural (provider = icu, locale = 'en-u-kn-true', deterministic = false)", ...sql.upQueries.map(query => query.query)], down: sql.downQueries.map(query => query.query), entities: source.entityMetadatas.map(entity => entity.tableName).sort() }
        writeFileSync('packages/server/api/src/app/database/migration/postgres/sydekyks-initial-schema.json', JSON.stringify(schema, null, 2) + '\n')
        console.log(JSON.stringify({ entities: schema.entities.length, queries: schema.up.length }))
    }
    finally { await source.destroy() }
}

generate().catch(error => { console.error(error.message); process.exitCode = 1 })
