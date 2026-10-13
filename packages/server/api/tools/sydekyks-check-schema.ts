import assert from 'node:assert/strict'
import { databaseConnection } from '../src/app/database/database-connection'

async function check(): Promise<void> {
    const source = databaseConnection()
    await source.initialize()
    assert.equal(source.options.synchronize, false)
    const migrations = await source.query('SELECT name FROM migrations')
    assert.equal(migrations.length, 1)
    assert.equal(migrations[0].name, 'SydekyksInitialSchema1880000000000')
    const drift = await source.driver.createSchemaBuilder().log()
    assert.equal(drift.upQueries.length, 0, 'Schema does not match entity definitions')
    const tables = await source.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")
    assert.equal(tables.length, 47)
    await source.destroy()
    await source.initialize()
    assert.equal((await source.query('SELECT name FROM migrations')).length, 1)
    await source.destroy()
    console.log(JSON.stringify({ freshMigration: true, productionSynchronize: false, tables: tables.length, schemaDrift: 0, restart: true }))
}

check().catch(error => { console.error(error.message); process.exitCode = 1 })
