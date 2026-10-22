import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

const v4 = 'single-credits-inclusive-1500-microusd-v4'
const additive = ['single-credits-500-microusd-v1', 'single-credits-250-microusd-v2', 'single-credits-1500-microusd-v3'].map(version => `'${version}'`).join(',')

export class SydekyksInclusiveCredits1914000000000 implements Migration {
    name = 'SydekyksInclusiveCredits1914000000000'
    breaking = false
    release = '1.0.23'
    async up(runner: QueryRunner): Promise<void> {
        // Only new roots opt in; no existing grants, reservations or charges change.
        await runner.query('ALTER TABLE hosting_reservation DROP CONSTRAINT "CHK_2e70855c6a0c5502ddc80c93f7", DROP CONSTRAINT chk_hosting_credit_accounting')
        await runner.query(`ALTER TABLE hosting_reservation ADD CONSTRAINT chk_hosting_reservation_amount_v4 CHECK ((amount>0 OR (kind='managed_ai' AND "accountingVersion" IS NOT NULL AND "accountingVersion"='${v4}' AND amount=0)) AND ("actualAmount" IS NULL OR "actualAmount">=0))`)
        await runner.query(`ALTER TABLE hosting_reservation ADD CONSTRAINT chk_hosting_credit_accounting CHECK (("accountingVersion" IS NULL) OR (kind='execution' AND "accountingVersion" IN (${additive}) AND "maxRootCredits" IS NOT NULL AND "maxRootCredits">=1) OR (kind='managed_ai' AND "accountingVersion" IN (${additive}) AND "microUsdPerCredit" IS NOT NULL AND "supplierMaxMicroUsd" IS NOT NULL AND "microUsdPerCredit">0 AND "supplierMaxMicroUsd">0 AND ("actualSupplierMicroUsd" IS NULL OR "actualSupplierMicroUsd">=0)) OR (kind='execution' AND "accountingVersion"='${v4}' AND amount=1 AND "maxRootCredits" IS NOT NULL AND "maxRootCredits">=1 AND "microUsdPerCredit" IS NOT NULL AND "microUsdPerCredit">0) OR (kind='managed_ai' AND "accountingVersion"='${v4}' AND payer='managed' AND "rootReservationId" IS NOT NULL AND amount=0 AND ("actualAmount" IS NULL OR "actualAmount"=0) AND "microUsdPerCredit" IS NOT NULL AND "microUsdPerCredit">0 AND "supplierMaxMicroUsd" IS NOT NULL AND "supplierMaxMicroUsd">0 AND ("actualSupplierMicroUsd" IS NULL OR "actualSupplierMicroUsd">=0)))`)
        await runner.query(`CREATE TABLE hosting_root_credit_usage (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL, "grantId" varchar(21) NOT NULL,
            "microUsdPerCredit" numeric(30,0) NOT NULL, "consumedCredits" numeric(30,0) NOT NULL, "reservedCredits" numeric(30,0) NOT NULL,
            "settledSupplierMicroUsd" numeric(30,0) NOT NULL, "heldSupplierMicroUsd" numeric(30,0) NOT NULL, revision integer NOT NULL,
            CONSTRAINT chk_hosting_root_credit_usage CHECK ("microUsdPerCredit">0 AND "consumedCredits">=0 AND "reservedCredits">=0 AND "settledSupplierMicroUsd">=0 AND "heldSupplierMicroUsd">=0 AND revision>=1),
            FOREIGN KEY(id,"platformId") REFERENCES hosting_reservation(id,"platformId") ON DELETE RESTRICT,
            FOREIGN KEY("grantId","platformId") REFERENCES hosting_grant(id,"platformId") ON DELETE RESTRICT
        )`)
        await runner.query('CREATE INDEX idx_hosting_root_credit_grant ON hosting_root_credit_usage ("platformId","grantId")')
    }
    async down(runner: QueryRunner): Promise<void> {
        const rows = await runner.query(`SELECT id FROM hosting_reservation WHERE "accountingVersion"='${v4}' UNION ALL SELECT id FROM hosting_root_credit_usage LIMIT 1`)
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_INCLUSIVE_CREDITS_ROLLBACK_REQUIRES_BACKUP_RESTORE')
        await runner.query('DROP TABLE hosting_root_credit_usage')
        await runner.query('ALTER TABLE hosting_reservation DROP CONSTRAINT chk_hosting_reservation_amount_v4, DROP CONSTRAINT chk_hosting_credit_accounting')
        await runner.query('ALTER TABLE hosting_reservation ADD CONSTRAINT "CHK_2e70855c6a0c5502ddc80c93f7" CHECK (amount>0 AND ("actualAmount" IS NULL OR "actualAmount">=0))')
        await runner.query(`ALTER TABLE hosting_reservation ADD CONSTRAINT chk_hosting_credit_accounting CHECK (("accountingVersion" IS NULL) OR (kind='execution' AND "accountingVersion" IN (${additive}) AND "maxRootCredits" IS NOT NULL AND "maxRootCredits">=1) OR (kind='managed_ai' AND "accountingVersion" IN (${additive}) AND "microUsdPerCredit" IS NOT NULL AND "supplierMaxMicroUsd" IS NOT NULL AND "microUsdPerCredit">0 AND "supplierMaxMicroUsd">0 AND ("actualSupplierMicroUsd" IS NULL OR "actualSupplierMicroUsd">=0)))`)
    }
}
