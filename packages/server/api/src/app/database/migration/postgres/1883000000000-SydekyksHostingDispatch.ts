import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksHostingDispatch1883000000000 implements Migration {
    name = 'SydekyksHostingDispatch1883000000000'
    breaking = false
    release = '0.93.0-sydekyks.8'

    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE hosting_dispatch (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "projectId" varchar(21) NOT NULL, "identityId" varchar(21) NOT NULL, "tokenVersion" varchar, "originType" varchar NOT NULL,
            "queueKey" varchar(64) NOT NULL, "payloadHash" varchar(64) NOT NULL,
            state varchar NOT NULL CONSTRAINT chk_hosting_dispatch_state CHECK (state IN ('prepared', 'admitted', 'running', 'completed', 'uncertain', 'cancelled')),
            "rootKey" varchar(120) NOT NULL, "reservationId" varchar(21), "admissionId" varchar(21), "dispatchId" varchar(21),
            "queueTokenHash" varchar(64), "connectionId" varchar, "flowRunId" varchar(21), "terminalReceipt" varchar, "completionStatus" varchar,
            FOREIGN KEY ("reservationId", "platformId") REFERENCES hosting_reservation(id, "platformId") ON DELETE RESTRICT
        )`)
        await runner.query('CREATE UNIQUE INDEX idx_hosting_dispatch_queue ON hosting_dispatch ("queueKey")')
        await runner.query('CREATE UNIQUE INDEX idx_hosting_dispatch_admission ON hosting_dispatch ("admissionId")')
        await runner.query('CREATE UNIQUE INDEX idx_hosting_dispatch_root ON hosting_dispatch ("platformId", "rootKey")')
    }

    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_dispatch IN ACCESS EXCLUSIVE MODE')
        const records: unknown = await runner.query('SELECT id FROM hosting_dispatch LIMIT 1')
        if (!Array.isArray(records) || records.length) throw new Error('HOSTING_DISPATCH_ROLLBACK_REQUIRES_EMPTY_TABLE')
        await runner.query('DROP TABLE hosting_dispatch')
    }
}
