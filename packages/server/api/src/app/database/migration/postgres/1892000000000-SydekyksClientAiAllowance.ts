import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksClientAiAllowance1892000000000 implements Migration {
    name = 'SydekyksClientAiAllowance1892000000000'
    breaking = false
    release = '1.0.9'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_ai_allowance_change (${base}, "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000), "operatorIdentityId" varchar(21) NOT NULL, "requestKey" varchar(100) NOT NULL, "payloadHash" varchar(64) NOT NULL, "monthlyCredits" integer CHECK("monthlyCredits" BETWEEN 0 AND 1000000), "previousMonthlyCredits" integer CHECK("previousMonthlyCredits" BETWEEN 0 AND 1000000), reason varchar(500), "grantSnapshots" jsonb NOT NULL CHECK(jsonb_typeof("grantSnapshots")='array' AND jsonb_array_length("grantSnapshots")<=256 AND octet_length("grantSnapshots"::text)<=262144), CONSTRAINT uq_hosting_ai_allowance_actor_request UNIQUE("operatorIdentityId","requestKey"), UNIQUE("platformId",revision), UNIQUE(id,"platformId",revision))`)
        await runner.query(`CREATE TABLE hosting_ai_allowance_binding (${base}, "platformId" varchar(21) NOT NULL UNIQUE REFERENCES hosting_account(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000), "changeId" varchar(21) NOT NULL, FOREIGN KEY("changeId","platformId",revision) REFERENCES hosting_ai_allowance_change(id,"platformId",revision) ON DELETE RESTRICT)`)
        await runner.query('CREATE FUNCTION hosting_ai_allowance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_AI_ALLOWANCE_HISTORY_IMMUTABLE\'; END $$')
        await runner.query('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hosting_ai_allowance_change FOR EACH ROW EXECUTE FUNCTION hosting_ai_allowance_immutable()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_ai_allowance_binding,hosting_ai_allowance_change IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_ai_allowance_change LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_AI_ALLOWANCE_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('DROP TABLE hosting_ai_allowance_binding')
        await runner.query('DROP TABLE hosting_ai_allowance_change')
        await runner.query('DROP FUNCTION hosting_ai_allowance_immutable()')
    }
}
