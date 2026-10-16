import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksHostingModelCalls1885000000000 implements Migration {
    name = 'SydekyksHostingModelCalls1885000000000'
    breaking = false
    release = '0.93.0-sydekyks.8'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE hosting_model_call (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL, "projectId" varchar(21) NOT NULL, "segmentId" varchar(21) NOT NULL,
            "rootReservationId" varchar(21) NOT NULL, "admissionId" varchar(21) NOT NULL, "identityId" varchar(21) NOT NULL,
            "callKey" varchar(100) NOT NULL, attempt integer NOT NULL, "requestHash" varchar(64) NOT NULL, payer varchar NOT NULL,
            "configId" varchar(21), "credentialFingerprint" varchar(64) NOT NULL, model varchar NOT NULL, endpoint varchar NOT NULL,
            state varchar NOT NULL, "reservationId" varchar(21), "dispatchId" varchar(21), fence varchar(21), "budgetDay" varchar(10),
            quote jsonb, response jsonb, usage jsonb, "actualMicroUsd" numeric(30,0), "sentAt" timestamptz, "leaseUntil" timestamptz NOT NULL,
            CONSTRAINT uq_hosting_call_attempt UNIQUE ("segmentId", "callKey", attempt),
            CONSTRAINT chk_hosting_call_state CHECK (state IN ('prepared', 'running', 'settled', 'uncertain', 'cancelled')),
            CONSTRAINT chk_hosting_call_attempt CHECK (attempt >= 0 AND attempt <= 2),
            CONSTRAINT chk_hosting_call_payer CHECK (payer IN ('managed', 'byok') AND ((payer = 'managed' AND "configId" IS NULL) OR (payer = 'byok' AND "configId" IS NOT NULL))),
            FOREIGN KEY ("segmentId", "platformId") REFERENCES hosting_dispatch(id, "platformId") ON DELETE RESTRICT,
            FOREIGN KEY ("rootReservationId", "platformId") REFERENCES hosting_reservation(id, "platformId") ON DELETE RESTRICT,
            FOREIGN KEY ("reservationId", "platformId") REFERENCES hosting_reservation(id, "platformId") ON DELETE RESTRICT
        )`)
        await runner.query('CREATE INDEX idx_hosting_call_root_state ON hosting_model_call ("platformId", "rootReservationId", state)')
        await runner.query('CREATE INDEX idx_hosting_call_recovery ON hosting_model_call (state, "leaseUntil")')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_model_call IN ACCESS EXCLUSIVE MODE')
        const records: unknown = await runner.query('SELECT id FROM hosting_model_call LIMIT 1')
        if (!Array.isArray(records) || records.length) throw new Error('HOSTING_MODEL_CALL_ROLLBACK_REQUIRES_EMPTY_TABLE')
        await runner.query('DROP TABLE hosting_model_call')
    }
}
