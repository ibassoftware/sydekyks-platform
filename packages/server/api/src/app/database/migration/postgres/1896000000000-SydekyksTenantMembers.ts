import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksTenantMembers1896000000000 implements Migration {
    name = 'SydekyksTenantMembers1896000000000'
    breaking = false
    release = '1.0.9'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_tenant_members_binding (${base}, revision integer NOT NULL CHECK(revision BETWEEN 0 AND 10000), FOREIGN KEY(id) REFERENCES hosting_account(id) ON DELETE RESTRICT)`)
        await runner.query(`CREATE TABLE hosting_tenant_members_command (${base}, "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT, "identityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "identityEmail" varchar NOT NULL, "identityTokenVersion" varchar, "actorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "actorTokenVersion" varchar, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 10000), "requestKey" varchar(100) NOT NULL, "requestHash" varchar(64) NOT NULL, action varchar NOT NULL CHECK(action IN ('invite','revoke','change')), "invitationId" varchar(21) UNIQUE REFERENCES hosting_invitation(id) ON DELETE RESTRICT, mode varchar CHECK(mode IN ('setup','existing')), "usedAt" timestamptz, UNIQUE("platformId","actorIdentityId","requestKey"), UNIQUE("platformId",revision), CHECK((action='invite' AND "invitationId" IS NOT NULL AND mode IS NOT NULL) OR (action<>'invite' AND "invitationId" IS NULL AND mode IS NULL)))`)
        await runner.query('CREATE FUNCTION hosting_tenant_members_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP=\'DELETE\' OR (to_jsonb(NEW)-\'usedAt\'-\'updated\') IS DISTINCT FROM (to_jsonb(OLD)-\'usedAt\'-\'updated\') OR (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt") THEN RAISE EXCEPTION \'HOSTING_MEMBER_HISTORY_IMMUTABLE\'; END IF; RETURN NEW; END $$')
        await runner.query('CREATE TRIGGER tenant_members_history_guard BEFORE UPDATE OR DELETE ON hosting_tenant_members_command FOR EACH ROW EXECUTE FUNCTION hosting_tenant_members_history_guard()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_tenant_members_binding,hosting_tenant_members_command IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_tenant_members_binding UNION ALL SELECT id FROM hosting_tenant_members_command LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_MEMBERS_ROLLBACK_REQUIRES_BACKUP_RESTORE')
        await runner.query('DROP TABLE hosting_tenant_members_command'); await runner.query('DROP TABLE hosting_tenant_members_binding'); await runner.query('DROP FUNCTION hosting_tenant_members_history_guard()')
    }
}
