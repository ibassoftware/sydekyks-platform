import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksAssessmentAccess1899000000000 implements Migration {
    name = 'SydekyksAssessmentAccess1899000000000'
    breaking = false
    release = '1.0.9-pilot'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('ALTER TABLE hosting_account DROP CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b"')
        await runner.query('ALTER TABLE hosting_account ADD CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b" CHECK ("planId" IN (\'trial\',\'training\',\'assessment\',\'starter\',\'team\'))')
        await runner.query(`CREATE TABLE hosting_assessment (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL UNIQUE REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "identityId" varchar(21) NOT NULL,
            "enrollmentId" varchar(21) NOT NULL UNIQUE REFERENCES lms_enrollment(id) ON DELETE RESTRICT,
            "trainingId" varchar(21) NOT NULL UNIQUE REFERENCES hosting_training(id) ON DELETE RESTRICT,
            "operatorIdentityId" varchar(21) NOT NULL, "startsAt" timestamptz NOT NULL, "endsAt" timestamptz NOT NULL,
            "revokedAt" timestamptz, CHECK ("endsAt" > "startsAt"))`)
        await runner.query('ALTER TABLE hosting_grant ADD CONSTRAINT ck_hosting_assessment_grant_cap CHECK ("sourceKey" NOT LIKE \'assessment:%\' OR (meter=\'execution\' AND amount<=100) OR (meter=\'managed_ai\' AND amount<=1000000))')
        await runner.query(`CREATE FUNCTION hosting_assessment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HOSTING_ASSESSMENT_HISTORY_IMMUTABLE'; END IF;
            IF ROW(NEW.id,NEW."platformId",NEW."identityId",NEW."enrollmentId",NEW."trainingId",NEW."operatorIdentityId",NEW."startsAt",NEW."endsAt") IS DISTINCT FROM ROW(OLD.id,OLD."platformId",OLD."identityId",OLD."enrollmentId",OLD."trainingId",OLD."operatorIdentityId",OLD."startsAt",OLD."endsAt") OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN RAISE EXCEPTION 'HOSTING_ASSESSMENT_HISTORY_IMMUTABLE'; END IF;
            RETURN NEW;
        END $$`)
        await runner.query('CREATE TRIGGER trg_hosting_assessment_immutable BEFORE UPDATE OR DELETE ON hosting_assessment FOR EACH ROW EXECUTE FUNCTION hosting_assessment_immutable()')
        // Locate the inline enum check by its definition rather than assuming an
        // auto-generated PostgreSQL constraint name from the earlier migration.
        await runner.query(`DO $$ DECLARE constraint_name text; BEGIN
            SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='lms_enrollment'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%accessType%' AND pg_get_constraintdef(oid) NOT LIKE '%package%';
            IF constraint_name IS NULL THEN RAISE EXCEPTION 'LMS_ACCESS_TYPE_CHECK_REQUIRED'; END IF;
            EXECUTE format('ALTER TABLE lms_enrollment DROP CONSTRAINT %I',constraint_name);
        END $$`)
        await runner.query('ALTER TABLE lms_enrollment ADD CONSTRAINT ck_lms_access_type CHECK ("accessType" IN (\'learning\',\'partner_course\',\'partner_training\'))')
        await runner.query(`ALTER TABLE lms_enrollment DROP CONSTRAINT ck_lms_learning_access,
            ADD CONSTRAINT ck_lms_learning_access CHECK (
                ("accessType" IN ('learning','partner_course') AND package IS NULL AND "paymentReference" IS NULL AND "workspacePlatformId" IS NULL)
                OR ("accessType"='partner_training' AND "grantPlatformId" IS NULL AND package IS NOT NULL AND "paymentReference" IS NOT NULL))`)
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_account,hosting_assessment,lms_enrollment IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_assessment UNION ALL SELECT id FROM hosting_account WHERE "planId"=\'assessment\' UNION ALL SELECT id FROM lms_enrollment WHERE "accessType"=\'partner_course\' LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_ASSESSMENT_ROLLBACK_REQUIRES_EMPTY_EVIDENCE')
        await runner.query('DROP TRIGGER trg_hosting_assessment_immutable ON hosting_assessment')
        await runner.query('DROP FUNCTION hosting_assessment_immutable()')
        await runner.query('DROP TABLE hosting_assessment')
        await runner.query('ALTER TABLE hosting_grant DROP CONSTRAINT ck_hosting_assessment_grant_cap')
        await runner.query('ALTER TABLE hosting_account DROP CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b"')
        await runner.query('ALTER TABLE hosting_account ADD CONSTRAINT "CHK_7a22f26b8fb98d989a5326db4b" CHECK ("planId" IN (\'trial\',\'training\',\'starter\',\'team\'))')
        await runner.query('ALTER TABLE lms_enrollment DROP CONSTRAINT ck_lms_access_type, ADD CONSTRAINT ck_lms_access_type CHECK ("accessType" IN (\'learning\',\'partner_training\'))')
        await runner.query('ALTER TABLE lms_enrollment DROP CONSTRAINT ck_lms_learning_access, ADD CONSTRAINT ck_lms_learning_access CHECK (("accessType"=\'learning\' AND package IS NULL AND "paymentReference" IS NULL AND "workspacePlatformId" IS NULL) OR ("accessType"=\'partner_training\' AND "grantPlatformId" IS NULL AND package IS NOT NULL AND "paymentReference" IS NOT NULL))')
    }
}
