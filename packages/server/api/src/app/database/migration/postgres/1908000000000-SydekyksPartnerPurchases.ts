import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksPartnerPurchases1908000000000 implements Migration {
    name = 'SydekyksPartnerPurchases1908000000000'
    breaking = false
    release = '1.0.20'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE hosting_partner_purchase (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT, "identityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT,
            "tokenVersion" varchar, "courseId" varchar(21) NOT NULL REFERENCES lms_course(id) ON DELETE RESTRICT,
            package varchar NOT NULL CHECK(package IN ('core','guided')), "stripeAccountId" varchar NOT NULL, "policyHash" varchar(64) NOT NULL,
            "priceId" varchar NOT NULL, "amountMinor" integer NOT NULL CHECK((package='core' AND "amountMinor"=100000) OR (package='guided' AND "amountMinor"=120000)),
            state varchar NOT NULL CHECK(state IN ('prepared','ready','fulfilled','refunded','expired','review')),
            "customerId" varchar, "sessionId" varchar UNIQUE, "checkoutUrl" varchar, "expiresAt" timestamptz, "firstSentAt" timestamptz, fence varchar, "leaseUntil" timestamptz, "reconcileAt" timestamptz NOT NULL,
            "chargeId" varchar UNIQUE, "paymentIntentId" varchar, "enrollmentId" varchar(21) UNIQUE REFERENCES lms_enrollment(id) ON DELETE RESTRICT, "trainingId" varchar(21) UNIQUE REFERENCES hosting_training(id) ON DELETE RESTRICT,
            "refundedMinor" integer NOT NULL DEFAULT 0 CHECK("refundedMinor">=0 AND "refundedMinor"<="amountMinor"), revision integer NOT NULL DEFAULT 0, reason varchar
        )`)
        await runner.query('CREATE UNIQUE INDEX uq_partner_purchase_active_workspace ON hosting_partner_purchase("platformId") WHERE state <> \'expired\'')
        await runner.query('CREATE INDEX idx_partner_purchase_reconcile ON hosting_partner_purchase("reconcileAt")')
        await runner.query('CREATE TABLE hosting_partner_purchase_audit (id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(), "purchaseId" varchar(21) NOT NULL REFERENCES hosting_partner_purchase(id) ON DELETE RESTRICT, revision integer NOT NULL, event varchar NOT NULL, evidence jsonb NOT NULL, UNIQUE("purchaseId",revision))')
        await runner.query('CREATE FUNCTION hosting_partner_purchase_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'HOSTING_PARTNER_PURCHASE_HISTORY_IMMUTABLE\'; END $$')
        await runner.query('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hosting_partner_purchase_audit FOR EACH ROW EXECUTE FUNCTION hosting_partner_purchase_audit_immutable()')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_partner_purchase IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_partner_purchase LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_PARTNER_PURCHASE_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('DROP TABLE hosting_partner_purchase_audit')
        await runner.query('DROP FUNCTION hosting_partner_purchase_audit_immutable()')
        await runner.query('DROP TABLE hosting_partner_purchase')
    }
}
