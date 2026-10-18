import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksPartnerAdmin1894000000000 implements Migration {
    name = 'SydekyksPartnerAdmin1894000000000'
    breaking = false
    release = '1.0.9'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_partner_admin_binding (${base}, revision integer NOT NULL CHECK(revision BETWEEN 0 AND 1000), FOREIGN KEY(id) REFERENCES user_identity(id) ON DELETE RESTRICT)`)
        await runner.query(`CREATE TABLE hosting_partner_admin_command (${base}, "identityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000), "operatorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "requestKey" varchar(100) NOT NULL, "payloadHash" varchar(64) NOT NULL, action varchar NOT NULL CHECK(action IN ('approve','deactivate','assign','unassign')), "platformId" varchar(21), CONSTRAINT uq_partner_admin_actor_request UNIQUE("operatorIdentityId","requestKey"), UNIQUE("identityId",revision))`)
        await runner.query('CREATE FUNCTION hosting_partner_admin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_PARTNER_HISTORY_IMMUTABLE\'; END $$')
        await runner.query('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hosting_partner_admin_command FOR EACH ROW EXECUTE FUNCTION hosting_partner_admin_immutable()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_partner_admin_binding,hosting_partner_admin_command IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_partner_admin_command LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_PARTNER_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('DROP TABLE hosting_partner_admin_command')
        await runner.query('DROP TABLE hosting_partner_admin_binding')
        await runner.query('DROP FUNCTION hosting_partner_admin_immutable()')
    }
}
