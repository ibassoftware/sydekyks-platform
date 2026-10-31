import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// Add an internal manual package without changing any existing terms or balances.
export class SydekyksPartnerStarter1917000000000 implements Migration {
    name = 'SydekyksPartnerStarter1917000000000'
    breaking = false
    release = '1.0.26'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('ALTER TABLE hosting_manual_account DROP CONSTRAINT hosting_manual_account_package_check')
        await runner.query("ALTER TABLE hosting_manual_account ADD CONSTRAINT hosting_manual_account_package_check CHECK (package IN ('starter','core','launch'))")
        await runner.query("ALTER TABLE hosting_manual_account ADD CONSTRAINT hosting_partner_starter_no_training CHECK (package <> 'starter' OR \"enrollmentId\" IS NULL)")
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_manual_account IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query("SELECT id FROM hosting_manual_account WHERE package='starter' LIMIT 1")
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_PARTNER_STARTER_ROLLBACK_HAS_ACCOUNTS')
        await runner.query('ALTER TABLE hosting_manual_account DROP CONSTRAINT hosting_partner_starter_no_training, DROP CONSTRAINT hosting_manual_account_package_check')
        await runner.query("ALTER TABLE hosting_manual_account ADD CONSTRAINT hosting_manual_account_package_check CHECK (package IN ('core','launch'))")
    }
}
