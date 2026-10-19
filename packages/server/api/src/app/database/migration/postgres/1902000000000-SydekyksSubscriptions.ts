import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksSubscriptions1902000000000 implements Migration {
    name = 'SydekyksSubscriptions1902000000000'
    breaking = false
    release = '1.0.9-pilot'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_subscription (${base}, revision integer NOT NULL CHECK(revision > 0), "renewalDueAt" timestamptz, "planId" varchar NOT NULL CHECK("planId" IN ('training','starter','team')), "entitlementId" varchar(21) NOT NULL, "sourceKey" varchar(180) NOT NULL, "accountValidUntil" timestamptz NOT NULL, "validFrom" timestamptz NOT NULL, "originalValidUntil" timestamptz NOT NULL, "executionGrantId" varchar(21) NOT NULL, "managedAiGrantId" varchar(21) NOT NULL, CHECK("originalValidUntil" > "validFrom"), FOREIGN KEY(id) REFERENCES hosting_account(id) ON DELETE RESTRICT, FOREIGN KEY("executionGrantId",id) REFERENCES hosting_grant(id,"platformId") ON DELETE RESTRICT, FOREIGN KEY("managedAiGrantId",id) REFERENCES hosting_grant(id,"platformId") ON DELETE RESTRICT)`)
        await runner.query(`CREATE TABLE hosting_subscription_command (${base}, "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT, "actorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "requestKey" varchar(100) NOT NULL, "payloadHash" varchar(64) NOT NULL, revision integer NOT NULL CHECK(revision > 0), reason varchar(500) NOT NULL, snapshot jsonb NOT NULL, UNIQUE("actorIdentityId","requestKey"), UNIQUE("platformId",revision))`)
        await runner.query('CREATE FUNCTION hosting_subscription_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_SUBSCRIPTION_HISTORY_IMMUTABLE\'; END $$')
        await runner.query('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hosting_subscription_command FOR EACH ROW EXECUTE FUNCTION hosting_subscription_immutable()')
        await runner.query('CREATE FUNCTION hosting_subscription_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP=\'DELETE\' OR NEW.revision <> OLD.revision+1 THEN RAISE EXCEPTION \'HOSTING_SUBSCRIPTION_REVISION_REQUIRED\'; END IF; RETURN NEW; END $$')
        await runner.query('CREATE TRIGGER revision_guard BEFORE UPDATE OR DELETE ON hosting_subscription FOR EACH ROW EXECUTE FUNCTION hosting_subscription_revision()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_subscription,hosting_subscription_command IN ACCESS EXCLUSIVE MODE')
        const rows = await runner.query('SELECT id FROM hosting_subscription UNION ALL SELECT id FROM hosting_subscription_command LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_SUBSCRIPTION_ROLLBACK_REQUIRES_BACKUP_RESTORE')
        await runner.query('DROP TABLE hosting_subscription_command')
        await runner.query('DROP TABLE hosting_subscription')
        await runner.query('DROP FUNCTION hosting_subscription_immutable()')
        await runner.query('DROP FUNCTION hosting_subscription_revision()')
    }
}
