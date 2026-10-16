import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksHostingStripe1886000000000 implements Migration {
    name = 'SydekyksHostingStripe1886000000000'
    breaking = false
    release = '0.93.0-sydekyks.8'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('ALTER TABLE hosting_account ADD COLUMN "billingHold" boolean NOT NULL DEFAULT false')
        await runner.query('ALTER TABLE hosting_grant ADD COLUMN "revokedAt" timestamptz')
        await runner.query(`CREATE TABLE hosting_stripe_binding (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL UNIQUE REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "stripeAccountId" varchar NOT NULL, "catalogHash" varchar NOT NULL, "customerId" varchar, "subscriptionId" varchar,
            "subscriptionStatus" varchar, "lastError" varchar, holds jsonb NOT NULL DEFAULT '[]'::jsonb, fence varchar, "leaseUntil" timestamptz,
            "reconcileAt" timestamptz NOT NULL, revision integer NOT NULL DEFAULT 0,
            UNIQUE ("stripeAccountId", "customerId"))`)
        await runner.query('CREATE INDEX idx_hosting_stripe_reconcile ON hosting_stripe_binding ("reconcileAt")')
        await runner.query(`CREATE TABLE hosting_stripe_command (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT,
            kind varchar NOT NULL CHECK (kind IN ('customer','checkout','portal')),
            state varchar NOT NULL CHECK (state IN ('prepared','running','uncertain','ready','closed')),
            "actorIdentityId" varchar(21) NOT NULL, "tokenVersion" varchar, payload jsonb NOT NULL, "payloadHash" varchar NOT NULL,
            "idempotencyKey" varchar NOT NULL, fence varchar, "firstSentAt" timestamptz, "leaseUntil" timestamptz,
            "objectId" varchar, url varchar, "expiresAt" timestamptz)`)
        await runner.query('CREATE UNIQUE INDEX uq_hosting_stripe_open_command ON hosting_stripe_command ("platformId",kind) WHERE state <> \'closed\'')
        await runner.query(`CREATE TABLE hosting_stripe_inbox (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "stripeAccountId" varchar NOT NULL, "eventId" varchar NOT NULL, "eventType" varchar NOT NULL, "rawHash" varchar NOT NULL, "eventHash" varchar NOT NULL,
            "objectId" varchar, "customerId" varchar, "chargeId" varchar, risk boolean NOT NULL DEFAULT false, state varchar NOT NULL CHECK (state IN ('pending','processed','ignored','quarantined')),
            "availableAt" timestamptz NOT NULL, reason varchar, UNIQUE ("stripeAccountId","eventId"))`)
        await runner.query('CREATE INDEX idx_hosting_stripe_inbox_due ON hosting_stripe_inbox (state,"availableAt")')
        await runner.query(`CREATE TABLE hosting_stripe_period (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "stripeAccountId" varchar NOT NULL, "customerId" varchar NOT NULL, "subscriptionId" varchar NOT NULL,
            "itemId" varchar NOT NULL, "priceId" varchar NOT NULL, "planId" varchar NOT NULL, "sourceKey" varchar NOT NULL,
            "periodStart" timestamptz NOT NULL, "periodEnd" timestamptz NOT NULL,
            "invoiceIds" jsonb NOT NULL, "lineIds" jsonb NOT NULL, "chargeIds" jsonb NOT NULL, "revokedAt" timestamptz,
            UNIQUE ("platformId","sourceKey"), CHECK ("periodEnd" > "periodStart"))`)
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_account,hosting_grant,hosting_stripe_binding,hosting_stripe_command,hosting_stripe_inbox,hosting_stripe_period IN ACCESS EXCLUSIVE MODE')
        for (const table of ['hosting_stripe_binding', 'hosting_stripe_command', 'hosting_stripe_inbox', 'hosting_stripe_period']) {
            const rows: unknown = await runner.query(`SELECT id FROM ${table} LIMIT 1`)
            if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_STRIPE_ROLLBACK_REQUIRES_EMPTY_TABLES')
        }
        const rows: unknown = await runner.query('SELECT id FROM hosting_account WHERE "billingHold" UNION ALL SELECT id FROM hosting_grant WHERE "revokedAt" IS NOT NULL LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_STRIPE_ROLLBACK_HAS_BILLING_EVIDENCE')
        for (const table of ['hosting_stripe_period', 'hosting_stripe_inbox', 'hosting_stripe_command', 'hosting_stripe_binding']) await runner.query(`DROP TABLE ${table}`)
        await runner.query('ALTER TABLE hosting_grant DROP COLUMN "revokedAt"')
        await runner.query('ALTER TABLE hosting_account DROP COLUMN "billingHold"')
    }
}
