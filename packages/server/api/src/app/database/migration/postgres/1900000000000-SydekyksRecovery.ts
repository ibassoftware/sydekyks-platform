import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksRecovery1900000000000 implements Migration {
    name = 'SydekyksRecovery1900000000000'
    breaking = false
    release = '1.0.9'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_recovery_binding (${base}, revision integer NOT NULL CHECK(revision BETWEEN 0 AND 1000), FOREIGN KEY(id) REFERENCES user_identity(id) ON DELETE RESTRICT)`)
        await runner.query(`CREATE TABLE hosting_recovery_token (${base}, "identityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "identityEmail" varchar NOT NULL, "identityTokenVersion" varchar, "operatorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "operatorPlatformId" varchar(21) NOT NULL, "operatorTokenVersion" varchar, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000), "requestKey" varchar(100) NOT NULL, "requestHash" varchar(64) NOT NULL, action varchar NOT NULL CHECK(action IN ('issue','revoke')), "tokenDigest" varchar(64) UNIQUE, "expiresAt" timestamptz NOT NULL, "usedAt" timestamptz, "revokedAt" timestamptz, method varchar NOT NULL CHECK(method='manual_recovery'), "verificationReason" varchar(1000) NOT NULL CHECK(length("verificationReason")>=10), "verificationEvidence" varchar(1000) NOT NULL CHECK(length("verificationEvidence")>=10), "emailOwnershipVerified" boolean NOT NULL CHECK("emailOwnershipVerified"=false), CONSTRAINT uq_recovery_actor_request UNIQUE("operatorIdentityId","requestKey"), UNIQUE("identityId",revision), CHECK((action='issue' AND "tokenDigest" IS NOT NULL) OR (action='revoke' AND "tokenDigest" IS NULL)))`)
        await runner.query('CREATE FUNCTION hosting_recovery_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP=\'DELETE\' THEN RAISE EXCEPTION \'HOSTING_RECOVERY_HISTORY_IMMUTABLE\'; END IF; IF (to_jsonb(NEW)-\'usedAt\'-\'revokedAt\'-\'updated\') IS DISTINCT FROM (to_jsonb(OLD)-\'usedAt\'-\'revokedAt\'-\'updated\') OR (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt") OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN RAISE EXCEPTION \'HOSTING_RECOVERY_HISTORY_IMMUTABLE\'; END IF; RETURN NEW; END $$')
        await runner.query('CREATE TRIGGER recovery_history_guard BEFORE UPDATE OR DELETE ON hosting_recovery_token FOR EACH ROW EXECUTE FUNCTION hosting_recovery_history_guard()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_recovery_binding, hosting_recovery_token IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_recovery_binding UNION ALL SELECT id FROM hosting_recovery_token LIMIT 1')
        if (!Array.isArray(rows) || rows.length > 0) throw new Error('HOSTING_RECOVERY_ROLLBACK_REQUIRES_BACKUP_RESTORE')
        await runner.query('DROP TABLE hosting_recovery_token')
        await runner.query('DROP TABLE hosting_recovery_binding')
        await runner.query('DROP FUNCTION hosting_recovery_history_guard()')
    }
}
