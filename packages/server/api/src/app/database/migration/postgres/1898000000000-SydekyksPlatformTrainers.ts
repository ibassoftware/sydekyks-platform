import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksPlatformTrainers1898000000000 implements Migration {
    name = 'SydekyksPlatformTrainers1898000000000'
    breaking = false
    release = '1.0.9'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_trainer_role (${base}, active boolean NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 0 AND 10000), "accessVersion" integer NOT NULL CHECK("accessVersion">=1), FOREIGN KEY(id) REFERENCES user_identity(id) ON DELETE RESTRICT)`)
        await runner.query(`CREATE TABLE hosting_trainer_assignment (${base}, "trainerIdentityId" varchar(21) NOT NULL REFERENCES hosting_trainer_role(id) ON DELETE RESTRICT, kind varchar NOT NULL CHECK(kind IN ('partner','client','recipient')), "partnerIdentityId" varchar(21) REFERENCES user_identity(id) ON DELETE RESTRICT, "clientPlatformId" varchar(21) REFERENCES hosting_account(id) ON DELETE RESTRICT, active boolean NOT NULL, revision integer NOT NULL CHECK(revision>=1), provenance varchar NOT NULL CHECK(provenance IN ('operator','onboarded')), "createdByIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "userId" varchar(21), UNIQUE("trainerIdentityId","partnerIdentityId"), UNIQUE("trainerIdentityId","clientPlatformId"), CHECK((kind IN ('partner','recipient') AND "partnerIdentityId" IS NOT NULL AND "clientPlatformId" IS NULL AND "userId" IS NULL) OR (kind='client' AND "clientPlatformId" IS NOT NULL AND "partnerIdentityId" IS NULL)))`)
        await runner.query(`CREATE TABLE hosting_trainer_command (${base}, "trainerIdentityId" varchar(21) NOT NULL REFERENCES hosting_trainer_role(id) ON DELETE RESTRICT, "actorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 10000), "requestKey" varchar(100) NOT NULL, "requestHash" varchar(64) NOT NULL, action varchar NOT NULL, details jsonb NOT NULL, UNIQUE("actorIdentityId","requestKey"), UNIQUE("trainerIdentityId",revision))`)
        await runner.query(`CREATE TABLE hosting_trainer_setup (${base}, "identityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "identityEmail" varchar NOT NULL, "identityTokenVersion" varchar, "trainerIdentityId" varchar(21) NOT NULL REFERENCES hosting_trainer_role(id) ON DELETE RESTRICT, "trainerPlatformId" varchar(21) NOT NULL, "trainerTokenVersion" varchar, "trainerAccessVersion" integer NOT NULL, "assignmentId" varchar(21) NOT NULL REFERENCES hosting_trainer_assignment(id) ON DELETE RESTRICT, "assignmentRevision" integer NOT NULL, kind varchar NOT NULL CHECK(kind IN ('partner','client')), "workspaceName" varchar(120) NOT NULL, "tokenDigest" varchar(64) NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "usedAt" timestamptz, "revokedAt" timestamptz)`)
        await runner.query('CREATE FUNCTION hosting_trainer_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_TRAINER_HISTORY_IMMUTABLE\'; END $$')
        await runner.query('CREATE TRIGGER trainer_command_guard BEFORE UPDATE OR DELETE ON hosting_trainer_command FOR EACH ROW EXECUTE FUNCTION hosting_trainer_command_immutable()')
        await runner.query('CREATE FUNCTION hosting_trainer_setup_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP=\'DELETE\' OR (to_jsonb(NEW)-\'usedAt\'-\'revokedAt\'-\'updated\') IS DISTINCT FROM (to_jsonb(OLD)-\'usedAt\'-\'revokedAt\'-\'updated\') OR (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt") OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN RAISE EXCEPTION \'HOSTING_TRAINER_HISTORY_IMMUTABLE\'; END IF; RETURN NEW; END $$')
        await runner.query('CREATE TRIGGER trainer_setup_guard BEFORE UPDATE OR DELETE ON hosting_trainer_setup FOR EACH ROW EXECUTE FUNCTION hosting_trainer_setup_guard()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_trainer_role,hosting_trainer_assignment,hosting_trainer_command,hosting_trainer_setup IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_trainer_role UNION ALL SELECT id FROM hosting_trainer_assignment UNION ALL SELECT id FROM hosting_trainer_command UNION ALL SELECT id FROM hosting_trainer_setup LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_TRAINER_ROLLBACK_REQUIRES_BACKUP_RESTORE')
        for (const table of ['hosting_trainer_setup', 'hosting_trainer_command', 'hosting_trainer_assignment', 'hosting_trainer_role']) await runner.query(`DROP TABLE ${table}`)
        await runner.query('DROP FUNCTION hosting_trainer_command_immutable()'); await runner.query('DROP FUNCTION hosting_trainer_setup_guard()')
    }
}
