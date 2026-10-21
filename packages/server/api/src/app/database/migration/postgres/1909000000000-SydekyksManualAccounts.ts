import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksManualAccounts1909000000000 implements Migration {
    name = 'SydekyksManualAccounts1909000000000'
    breaking = false
    release = '1.0.21'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE hosting_manual_term (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "identityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT,
            "planId" varchar NOT NULL CHECK("planId" IN ('training','starter','team','scale')),
            revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000), "startsAt" timestamptz NOT NULL, "expiresAt" timestamptz NOT NULL,
            "monthlyCredits" integer NOT NULL CHECK("monthlyCredits" BETWEEN 0 AND 1000000),
            "operatorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, reason varchar(500) NOT NULL,
            CHECK("expiresAt">"startsAt"), UNIQUE("platformId",revision)
        )`)
        await runner.query(`CREATE TABLE hosting_manual_account (
            id varchar(21) PRIMARY KEY REFERENCES hosting_account(id) ON DELETE RESTRICT, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "identityId" varchar(21) NOT NULL UNIQUE REFERENCES user_identity(id) ON DELETE RESTRICT,
            kind varchar NOT NULL CHECK(kind IN ('partner','client')), package varchar CHECK(package IN ('core','launch')),
            "enrollmentId" varchar(21) REFERENCES lms_enrollment(id) ON DELETE RESTRICT,
            "termId" varchar(21) NOT NULL REFERENCES hosting_manual_term(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000),
            CHECK((kind='partner' AND package IS NOT NULL) OR (kind='client' AND package IS NULL AND "enrollmentId" IS NULL))
        )`)
        await runner.query(`CREATE TABLE hosting_manual_command (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "operatorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "requestKey" varchar(100) NOT NULL, "payloadHash" varchar(64) NOT NULL,
            action varchar NOT NULL CHECK(action IN ('create','renew','enroll')), "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "termId" varchar(21) NOT NULL REFERENCES hosting_manual_term(id) ON DELETE RESTRICT, snapshot jsonb NOT NULL,
            CONSTRAINT uq_manual_command_actor_request UNIQUE("operatorIdentityId","requestKey")
        )`)
        await runner.query('CREATE FUNCTION hosting_manual_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_MANUAL_HISTORY_IMMUTABLE\'; END $$')
        for (const table of ['hosting_manual_term', 'hosting_manual_command']) await runner.query(`CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hosting_manual_history_immutable()`)
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_manual_account IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_manual_account LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_MANUAL_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('DROP TABLE hosting_manual_command')
        await runner.query('DROP TABLE hosting_manual_account')
        await runner.query('DROP TABLE hosting_manual_term')
        await runner.query('DROP FUNCTION hosting_manual_history_immutable()')
    }
}
