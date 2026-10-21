import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksStripeCatalogMigration1906000000000 implements Migration {
    name = 'SydekyksStripeCatalogMigration1906000000000'
    breaking = false
    release = '1.0.19'
    async up(runner: QueryRunner): Promise<void> {
        const base = 'id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now()'
        await runner.query(`CREATE TABLE hosting_stripe_catalog_preview (${base}, "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT, "operatorIdentityId" varchar(21) NOT NULL, "tokenVersion" text, "sourceHash" varchar(64) NOT NULL, "targetHash" varchar(64) NOT NULL, "evidenceHash" varchar(64) NOT NULL, "expiresAt" timestamptz NOT NULL, snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=262144))`)
        await runner.query(`CREATE TABLE hosting_stripe_catalog_change (${base}, "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT, "previewId" varchar(21) NOT NULL UNIQUE REFERENCES hosting_stripe_catalog_preview(id) ON DELETE RESTRICT, "operatorIdentityId" varchar(21) NOT NULL, "requestKey" varchar(100) NOT NULL, "payloadHash" varchar(64) NOT NULL, "sourceHash" varchar(64) NOT NULL, "targetHash" varchar(64) NOT NULL, "evidenceHash" varchar(64) NOT NULL, revision integer NOT NULL, reason varchar(500) NOT NULL, CONSTRAINT uq_hosting_stripe_catalog_actor_request UNIQUE("operatorIdentityId","requestKey"))`)
        await runner.query('CREATE FUNCTION hosting_stripe_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_STRIPE_CATALOG_HISTORY_IMMUTABLE\'; END $$')
        for (const table of ['hosting_stripe_catalog_preview', 'hosting_stripe_catalog_change']) await runner.query(`CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hosting_stripe_catalog_immutable()`)
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_stripe_catalog_preview,hosting_stripe_catalog_change IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_stripe_catalog_preview LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_STRIPE_CATALOG_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('DROP TABLE hosting_stripe_catalog_change')
        await runner.query('DROP TABLE hosting_stripe_catalog_preview')
        await runner.query('DROP FUNCTION hosting_stripe_catalog_immutable()')
    }
}
