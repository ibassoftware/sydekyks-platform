import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksDefaultLearning1915000000000 implements Migration {
    name = 'SydekyksDefaultLearning1915000000000'
    breaking = false
    release = '1.0.24'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('ALTER TABLE lms_course ADD COLUMN "clientDefault" boolean NOT NULL DEFAULT false, ADD CONSTRAINT chk_lms_client_default CHECK (NOT "clientDefault" OR ("ownerPlatformId" IS NULL AND audience=\'end_user\' AND "certificationMode"=\'none\' AND status=\'published\'))')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('ALTER TABLE lms_course DROP CONSTRAINT chk_lms_client_default, DROP COLUMN "clientDefault"')
    }
}
