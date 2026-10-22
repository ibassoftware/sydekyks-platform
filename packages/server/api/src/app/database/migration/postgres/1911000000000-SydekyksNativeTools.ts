import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksNativeTools1911000000000 implements Migration {
    name = 'SydekyksNativeTools1911000000000'
    breaking = false
    release = '1.0.22'

    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`ALTER TABLE hosting_model_call
            ADD COLUMN "nativeTool" varchar,
            ADD COLUMN "nativeFeature" boolean NOT NULL DEFAULT false,
            ADD COLUMN "toolUnitPriceMicroUsd" numeric(30,0),
            ADD COLUMN "toolTariffVersion" varchar,
            ADD CONSTRAINT chk_hosting_native_tool CHECK (
                ("nativeTool" IS NULL AND "toolUnitPriceMicroUsd" IS NULL AND "toolTariffVersion" IS NULL)
                OR ("nativeTool" IS NOT NULL AND "toolUnitPriceMicroUsd" IS NOT NULL AND "nativeTool" IN ('search','fetch') AND "nativeFeature" AND "toolUnitPriceMicroUsd" > 0 AND "toolTariffVersion" IS NOT NULL)
            )`)
    }

    async down(runner: QueryRunner): Promise<void> {
        if ((await runner.query('SELECT id FROM hosting_model_call WHERE "nativeFeature" LIMIT 1')).length) throw new Error('NATIVE_TOOLS_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('ALTER TABLE hosting_model_call DROP CONSTRAINT chk_hosting_native_tool, DROP COLUMN "nativeTool", DROP COLUMN "nativeFeature", DROP COLUMN "toolUnitPriceMicroUsd", DROP COLUMN "toolTariffVersion"')
    }
}
