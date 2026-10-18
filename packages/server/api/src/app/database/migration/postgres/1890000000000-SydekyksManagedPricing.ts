import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksManagedPricing1890000000000 implements Migration {
    name = 'SydekyksManagedPricing1890000000000'
    breaking = false
    release = '1.0.9'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_pricing_observation (${base}, fence varchar(21) NOT NULL, state varchar NOT NULL CHECK(state IN ('verified','error')), terms jsonb, "termsHash" varchar, "contentHash" varchar, "observedAt" timestamptz NOT NULL, "sourceAt" timestamptz, reason varchar)`)
        await runner.query(`CREATE TABLE hosting_pricing_approval (${base}, "observationId" varchar(21) NOT NULL REFERENCES hosting_pricing_observation(id) ON DELETE RESTRICT, "termsHash" varchar NOT NULL, "calendarVersion" varchar NOT NULL, "identityId" varchar(21) NOT NULL, "requestKey" varchar(120) NOT NULL, "payloadHash" varchar NOT NULL, "validFrom" timestamptz NOT NULL, "validUntil" timestamptz NOT NULL, UNIQUE("identityId","requestKey"), CHECK("validUntil">"validFrom"))`)
        await runner.query(`CREATE TABLE hosting_pricing_state (${base}, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), "approvalId" varchar(21) REFERENCES hosting_pricing_approval(id) ON DELETE RESTRICT, "observationId" varchar(21) REFERENCES hosting_pricing_observation(id) ON DELETE RESTRICT, "fetchFence" varchar(21), "leaseUntil" timestamptz, status varchar NOT NULL CHECK(status IN ('unconfigured','checking','ready','needs_approval','mismatch','error')))`)
        await runner.query(`CREATE TABLE hosting_managed_secret (${base}, auth jsonb NOT NULL, "identityId" varchar(21) NOT NULL)`)
        await runner.query(`CREATE TABLE hosting_managed_profile (${base}, "scopeKey" varchar NOT NULL, mode varchar NOT NULL CHECK(mode IN ('set','inherit','disabled')), model varchar CHECK(model IN ('deepseek-flash','deepseek-v4-pro')), "secretId" varchar(21) REFERENCES hosting_managed_secret(id) ON DELETE RESTRICT, "identityId" varchar(21) NOT NULL, "requestKey" varchar(120) NOT NULL, "payloadHash" varchar NOT NULL, UNIQUE("identityId","requestKey"))`)
        await runner.query(`CREATE TABLE hosting_managed_binding (${base}, "scopeKey" varchar NOT NULL UNIQUE, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), "profileId" varchar(21) REFERENCES hosting_managed_profile(id) ON DELETE RESTRICT)`)
        await runner.query('CREATE FUNCTION hosting_pricing_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_PRICING_HISTORY_IMMUTABLE\'; END $$')
        for (const table of ['hosting_pricing_observation', 'hosting_pricing_approval', 'hosting_managed_secret', 'hosting_managed_profile']) await runner.query(`CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hosting_pricing_immutable()`)
    }
    async down(runner: QueryRunner): Promise<void> {
        const tables = ['hosting_pricing_state', 'hosting_managed_binding', 'hosting_managed_profile', 'hosting_managed_secret', 'hosting_pricing_approval', 'hosting_pricing_observation']
        await runner.query(`LOCK TABLE ${tables.join(',')} IN ACCESS EXCLUSIVE MODE`)
        for (const table of tables) {
            const rows: unknown = await runner.query(`SELECT id FROM ${table} LIMIT 1`)
            if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_PRICING_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        }
        for (const table of tables) await runner.query(`DROP TABLE ${table}`)
        await runner.query('DROP FUNCTION hosting_pricing_immutable()')
    }
}
