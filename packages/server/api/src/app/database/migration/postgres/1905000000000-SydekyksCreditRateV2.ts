import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksCreditRateV21905000000000 implements Migration {
    name = 'SydekyksCreditRateV21905000000000'
    breaking = false
    release = '1.0.9-pilot'
    async up(runner: QueryRunner): Promise<void> {
        await replaceConstraint(runner, ['single-credits-500-microusd-v1', 'single-credits-250-microusd-v2'])
    }
    async down(runner: QueryRunner): Promise<void> {
        const rows = await runner.query('SELECT id FROM hosting_reservation WHERE "accountingVersion"=\'single-credits-250-microusd-v2\' LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_CREDIT_RATE_ROLLBACK_REQUIRES_BACKUP_RESTORE')
        await replaceConstraint(runner, ['single-credits-500-microusd-v1'])
    }
}

async function replaceConstraint(runner: QueryRunner, versions: string[]): Promise<void> {
    // Fixed migration literals only. Preserve every reservation and its stored rate.
    const accepted = versions.map(version => `'${version}'`).join(',')
    await runner.query('ALTER TABLE hosting_reservation DROP CONSTRAINT chk_hosting_credit_accounting')
    await runner.query(`ALTER TABLE hosting_reservation ADD CONSTRAINT chk_hosting_credit_accounting CHECK (("accountingVersion" IS NULL) OR (kind='execution' AND "accountingVersion" IN (${accepted}) AND "maxRootCredits" IS NOT NULL AND "maxRootCredits">=1) OR (kind='managed_ai' AND "accountingVersion" IN (${accepted}) AND "microUsdPerCredit" IS NOT NULL AND "supplierMaxMicroUsd" IS NOT NULL AND "microUsdPerCredit">0 AND "supplierMaxMicroUsd">0 AND ("actualSupplierMicroUsd" IS NULL OR "actualSupplierMicroUsd">=0)))`)
}
