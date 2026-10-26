import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksStorageLimits1901000000000 implements Migration {
    name = 'SydekyksStorageLimits1901000000000'
    breaking = false
    release = '1.0.9-pilot'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('CREATE TABLE hosting_storage_lock (id varchar PRIMARY KEY CHECK (id=\'global\'))')
        await runner.query('INSERT INTO hosting_storage_lock(id) VALUES (\'global\')')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP TABLE hosting_storage_lock')
    }
}
