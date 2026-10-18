import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksCourseAccess1897000000000 implements Migration {
    name = 'SydekyksCourseAccess1897000000000'
    breaking = false
    release = '1.0.9-pilot'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`ALTER TABLE lms_course
            ADD COLUMN "ownerPlatformId" varchar(21) REFERENCES platform(id) ON DELETE RESTRICT,
            ADD COLUMN audience varchar NOT NULL DEFAULT 'partner' CHECK (audience IN ('partner','end_user')),
            ADD COLUMN "certificationMode" varchar NOT NULL DEFAULT 'partner' CHECK ("certificationMode" IN ('partner','none')),
            ADD CONSTRAINT ck_lms_private_course CHECK ("ownerPlatformId" IS NULL OR (audience='end_user' AND "certificationMode"='none')),
            ADD CONSTRAINT ck_lms_partner_certification CHECK ("certificationMode"='none' OR ("ownerPlatformId" IS NULL AND audience='partner'))`)
        await runner.query(`ALTER TABLE lms_enrollment
            ADD COLUMN "grantPlatformId" varchar(21) REFERENCES platform(id) ON DELETE RESTRICT,
            ADD COLUMN "accessType" varchar NOT NULL DEFAULT 'partner_training' CHECK ("accessType" IN ('learning','partner_training')),
            ALTER COLUMN package DROP NOT NULL,
            ALTER COLUMN "paymentReference" DROP NOT NULL,
            DROP CONSTRAINT uq_lms_identity_course,
            ADD CONSTRAINT ck_lms_learning_access CHECK (
                ("accessType"='learning' AND package IS NULL AND "paymentReference" IS NULL AND "workspacePlatformId" IS NULL)
                OR ("accessType"='partner_training' AND "grantPlatformId" IS NULL AND package IS NOT NULL AND "paymentReference" IS NOT NULL))`)
        await runner.query('CREATE UNIQUE INDEX uq_lms_global_identity_course ON lms_enrollment ("identityId","courseId") WHERE "grantPlatformId" IS NULL')
        await runner.query('CREATE UNIQUE INDEX uq_lms_scoped_identity_course ON lms_enrollment ("identityId","courseId","grantPlatformId") WHERE "grantPlatformId" IS NOT NULL')
        await runner.query('CREATE INDEX idx_lms_course_owner ON lms_course ("ownerPlatformId",status)')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE lms_course,lms_enrollment IN ACCESS EXCLUSIVE MODE')
        if ((await runner.query('SELECT id FROM lms_course LIMIT 1')).length || (await runner.query('SELECT id FROM lms_enrollment LIMIT 1')).length) throw new Error('LMS_COURSE_ACCESS_ROLLBACK_REQUIRES_EMPTY_COURSES')
        await runner.query('DROP INDEX idx_lms_course_owner')
        await runner.query('DROP INDEX uq_lms_global_identity_course')
        await runner.query('DROP INDEX uq_lms_scoped_identity_course')
        await runner.query('ALTER TABLE lms_enrollment DROP CONSTRAINT ck_lms_learning_access, DROP COLUMN "grantPlatformId", DROP COLUMN "accessType", ALTER COLUMN package SET NOT NULL, ALTER COLUMN "paymentReference" SET NOT NULL, ADD CONSTRAINT uq_lms_identity_course UNIQUE ("identityId","courseId")')
        await runner.query('ALTER TABLE lms_course DROP CONSTRAINT ck_lms_private_course, DROP CONSTRAINT ck_lms_partner_certification, DROP COLUMN "ownerPlatformId", DROP COLUMN audience, DROP COLUMN "certificationMode"')
    }
}
