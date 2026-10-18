import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksTrainingGrants1889000000000 implements Migration {
    name = 'SydekyksTrainingGrants1889000000000'
    breaking = false
    release = '1.0.9'

    async up(runner: QueryRunner): Promise<void> {
        await runner.query('ALTER TABLE hosting_account DROP CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b"')
        await runner.query('ALTER TABLE hosting_account ADD CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b" CHECK ("planId" IN (\'trial\', \'training\', \'starter\', \'team\'))')
        await runner.query(`CREATE TABLE hosting_training (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL UNIQUE REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "identityId" varchar(21) NOT NULL, "enrollmentId" varchar(21) NOT NULL UNIQUE,
            "receiptId" varchar(180) NOT NULL UNIQUE, tier varchar NOT NULL CHECK (tier IN ('core','launch')),
            "operatorIdentityId" varchar(21) NOT NULL, "startsAt" timestamptz NOT NULL, "endsAt" timestamptz NOT NULL,
            "revokedAt" timestamptz, CHECK ("endsAt" > "startsAt"))`)
    }

    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_account,hosting_training IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_training UNION ALL SELECT id FROM hosting_account WHERE "planId"=\'training\' LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_TRAINING_ROLLBACK_REQUIRES_EMPTY_EVIDENCE')
        await runner.query('DROP TABLE hosting_training')
        await runner.query('ALTER TABLE hosting_account DROP CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b"')
        await runner.query('ALTER TABLE hosting_account ADD CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b" CHECK ("planId" IN (\'trial\', \'starter\', \'team\'))')
    }
}
