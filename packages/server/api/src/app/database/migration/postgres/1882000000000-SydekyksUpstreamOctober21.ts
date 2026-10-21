import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'
import { AddBarrierChildAttribution1871000000000 } from './1871000000000-AddBarrierChildAttribution'
import { AddPieceTranslationTable1873000000000 } from './1873000000000-AddPieceTranslationTable'

export class SydekyksUpstreamOctober211882000000000 implements Migration {
    name = 'SydekyksUpstreamOctober211882000000000'
    breaking = false
    release = '0.93.0-sydekyks.9'
    transaction = false

    async up(queryRunner: QueryRunner): Promise<void> {
        await new AddBarrierChildAttribution1871000000000().up(queryRunner)
        await new AddPieceTranslationTable1873000000000().up(queryRunner)
        await queryRunner.query('ALTER TABLE "platform_configuration" ADD COLUMN IF NOT EXISTS "defaultChatModel" jsonb')
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "platform_configuration" DROP COLUMN IF EXISTS "defaultChatModel"')
        await new AddPieceTranslationTable1873000000000().down(queryRunner)
        await new AddBarrierChildAttribution1871000000000().down(queryRunner)
    }
}
