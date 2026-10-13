import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'
import schema from './sydekyks-initial-schema.json'

export class SydekyksInitialSchema1880000000000 implements Migration {
    name = 'SydekyksInitialSchema1880000000000'
    breaking = true
    release = '0.93.0-sydekyks.1'

    async up(queryRunner: QueryRunner): Promise<void> {
        const existing = await queryRunner.query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> \'migrations\'')
        if (existing.length > 0) throw new Error('This first Sydekyks release requires an empty database. Preserve existing data and use a new database.')
        if (schema.up.length === 0) throw new Error('The release schema has not been generated')
        for (const query of schema.up) await queryRunner.query(query)
    }

    async down(_queryRunner: QueryRunner): Promise<void> {
        throw new Error('Restore a backup to roll back the initial Sydekyks schema; automatic rollback would destroy data')
    }
}
