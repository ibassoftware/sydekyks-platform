import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksUpstream1031881000000000 implements Migration {
    name = 'SydekyksUpstream1031881000000000'
    breaking = false
    release = '0.93.0-sydekyks.3'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "platform_model_tier" ADD "isFast" boolean NOT NULL DEFAULT false')
        await queryRunner.query('UPDATE "platform_model_tier" SET "isFast" = true WHERE "isDefault" = true AND "deleted" IS NULL')
        await queryRunner.query('CREATE UNIQUE INDEX "idx_platform_model_tier_platform_fast" ON "platform_model_tier" ("platformId") WHERE "isFast" = true AND "deleted" IS NULL')
        await queryRunner.query('ALTER TABLE "platform_configuration" ADD "aiSpecificModelsVisible" boolean NOT NULL DEFAULT true')
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "platform_configuration" DROP COLUMN "aiSpecificModelsVisible"')
        await queryRunner.query('DROP INDEX "idx_platform_model_tier_platform_fast"')
        await queryRunner.query('ALTER TABLE "platform_model_tier" DROP COLUMN "isFast"')
    }
}
