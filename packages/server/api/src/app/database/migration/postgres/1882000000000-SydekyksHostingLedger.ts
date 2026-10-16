import { QueryRunner } from 'typeorm'
import { z } from 'zod'
import { Migration } from '../../migration'
import schema from './sydekyks-hosting-schema.json'

const tables = ['hosting_outbox', 'hosting_invitation', 'hosting_ledger', 'hosting_reservation', 'hosting_grant', 'hosting_account', 'hosting_eligibility', 'hosting_policy', 'hosting_daily_budget']

export class SydekyksHostingLedger1882000000000 implements Migration {
    name = 'SydekyksHostingLedger1882000000000'
    breaking = false
    release = '0.93.0-sydekyks.8'

    async up(queryRunner: QueryRunner): Promise<void> {
        for (const query of schema.up) await queryRunner.query(query)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`LOCK TABLE ${tables.map(table => `"${table}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`)
        for (const table of tables) {
            const rows = z.array(z.object({ exists: z.boolean() })).parse(await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "${table}") AS exists`))
            if (rows[0].exists) throw new Error('HOSTING_ROLLBACK_REQUIRES_EMPTY_TABLES: preserve financial and trial eligibility records')
        }
        for (const table of tables) await queryRunner.query(`DROP TABLE "${table}"`)
        await queryRunner.query('DROP FUNCTION hosting_reject_ledger_mutation()')
    }
}
