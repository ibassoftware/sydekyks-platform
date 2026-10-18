import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksPricingValidation1893000000000 implements Migration {
    name = 'SydekyksPricingValidation1893000000000'
    breaking = false
    release = '1.0.9'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('ALTER TABLE hosting_pricing_observation ADD COLUMN "sourceValidation" jsonb CHECK("sourceValidation" IS NULL OR (jsonb_typeof("sourceValidation")=\'object\' AND octet_length("sourceValidation"::text)<=4096))')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_pricing_observation IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_pricing_observation WHERE "sourceValidation" IS NOT NULL LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_PRICING_VALIDATION_ROLLBACK_REQUIRES_EMPTY_PROVENANCE')
        await runner.query('ALTER TABLE hosting_pricing_observation DROP COLUMN "sourceValidation"')
    }
}
