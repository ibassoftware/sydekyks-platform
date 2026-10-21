import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksChargeResolution1907000000000 implements Migration {
    name = 'SydekyksChargeResolution1907000000000'
    breaking = false
    release = '1.0.19'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('CREATE TABLE hosting_charge_resolution (id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(), "platformId" varchar(21) NOT NULL, "callId" varchar(21) NOT NULL REFERENCES hosting_model_call(id) ON DELETE RESTRICT, "rootReservationId" varchar(21) NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000), "operatorIdentityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "operatorPlatformId" varchar(21) NOT NULL, "operatorUserId" varchar(21) NOT NULL, "requestKey" varchar(100) NOT NULL, "requestHash" varchar(64) NOT NULL, "beforeHash" varchar(64) NOT NULL, outcome varchar NOT NULL CHECK(outcome IN (\'verified_usage\',\'confirmed_not_sent\',\'retain\')), reason varchar(1000) NOT NULL, "evidenceReference" varchar(1000) NOT NULL, "supplierRequestId" varchar(200), snapshot jsonb NOT NULL, result jsonb NOT NULL, FOREIGN KEY("rootReservationId","platformId") REFERENCES hosting_reservation(id,"platformId") ON DELETE RESTRICT, CONSTRAINT uq_hosting_resolution_actor_request UNIQUE("operatorIdentityId","requestKey"), UNIQUE("callId",revision))')
        await runner.query('CREATE FUNCTION hosting_charge_resolution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_CHARGE_RESOLUTION_HISTORY_IMMUTABLE\'; END $$')
        await runner.query('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hosting_charge_resolution FOR EACH ROW EXECUTE FUNCTION hosting_charge_resolution_immutable()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_charge_resolution IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_charge_resolution LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_CHARGE_RESOLUTION_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('DROP TABLE hosting_charge_resolution')
        await runner.query('DROP FUNCTION hosting_charge_resolution_immutable()')
    }
}
