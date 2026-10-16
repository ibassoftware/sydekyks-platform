import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksHostingSegments1884000000000 implements Migration {
    name = 'SydekyksHostingSegments1884000000000'
    breaking = false
    release = '0.93.0-sydekyks.8'

    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`ALTER TABLE hosting_dispatch
            ADD COLUMN "rootDispatchId" varchar(21), ADD COLUMN "parentDispatchId" varchar(21), ADD COLUMN generation integer NOT NULL DEFAULT 0,
            ADD COLUMN "waitpointId" varchar(21), ADD COLUMN "callbackWaitpointId" varchar(21), ADD COLUMN "resolutionStatus" varchar, ADD COLUMN checkpoint jsonb, ADD COLUMN "requestHash" varchar, ADD COLUMN "queueName" varchar, ADD COLUMN "jobId" varchar, ADD COLUMN payload jsonb,
            ADD COLUMN "availableAt" timestamptz, ADD COLUMN "leaseUntil" timestamptz, ADD COLUMN "publishedAt" timestamptz,
            ADD CONSTRAINT uq_hosting_dispatch_scope UNIQUE (id, "platformId"),
            ADD CONSTRAINT uq_hosting_dispatch_generation UNIQUE ("platformId", "flowRunId", generation),
            ADD CONSTRAINT chk_hosting_dispatch_generation CHECK (generation >= 0),
            ADD FOREIGN KEY ("rootDispatchId", "platformId") REFERENCES hosting_dispatch(id, "platformId") ON DELETE RESTRICT,
            ADD FOREIGN KEY ("parentDispatchId", "platformId") REFERENCES hosting_dispatch(id, "platformId") ON DELETE RESTRICT`)
        await runner.query('ALTER TABLE waitpoint ADD COLUMN "hostingDispatchId" varchar(21) REFERENCES hosting_dispatch(id) ON DELETE RESTRICT')
        await runner.query('ALTER TABLE hosting_dispatch DROP CONSTRAINT chk_hosting_dispatch_state')
        await runner.query('ALTER TABLE hosting_dispatch ADD CONSTRAINT chk_hosting_dispatch_state CHECK (state IN (\'prepared\', \'admitted\', \'running\', \'completed\', \'uncertain\', \'cancelled\', \'paused\'))')
        const constraints: { name: string }[] = await runner.query('SELECT conname AS name FROM pg_constraint WHERE conrelid = \'hosting_reservation\'::regclass AND contype = \'c\' AND pg_get_constraintdef(oid) LIKE \'%state%\'')
        for (const { name } of constraints) await runner.query(`ALTER TABLE hosting_reservation DROP CONSTRAINT "${name.replaceAll('"', '""')}"`)
        await runner.query('ALTER TABLE hosting_reservation ADD CONSTRAINT chk_hosting_reservation_state CHECK (state IN (\'reserved\', \'running\', \'settled\', \'released\', \'uncertain\', \'paused\'))')
        await runner.query('CREATE INDEX idx_hosting_dispatch_recovery ON hosting_dispatch (state, updated, id)')
        await runner.query('CREATE INDEX idx_hosting_dispatch_tree ON hosting_dispatch ("platformId", "rootDispatchId")')
    }

    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_dispatch, hosting_reservation IN ACCESS EXCLUSIVE MODE')
        const records: unknown = await runner.query('SELECT id FROM hosting_dispatch LIMIT 1')
        if (!Array.isArray(records) || records.length) throw new Error('HOSTING_SEGMENTS_ROLLBACK_REQUIRES_EMPTY_DISPATCH_TABLE')
        const paused: unknown = await runner.query('SELECT id FROM hosting_reservation WHERE state = \'paused\' LIMIT 1')
        if (!Array.isArray(paused) || paused.length) throw new Error('HOSTING_SEGMENTS_ROLLBACK_REQUIRES_NO_PAUSED_RESERVATIONS')
        await runner.query('ALTER TABLE waitpoint DROP COLUMN "hostingDispatchId"')
        await runner.query('DROP INDEX idx_hosting_dispatch_recovery')
        await runner.query('DROP INDEX idx_hosting_dispatch_tree')
        await runner.query('ALTER TABLE hosting_dispatch DROP COLUMN "rootDispatchId", DROP COLUMN "parentDispatchId", DROP COLUMN generation, DROP COLUMN "waitpointId", DROP COLUMN "callbackWaitpointId", DROP COLUMN "resolutionStatus", DROP COLUMN checkpoint, DROP COLUMN "requestHash", DROP COLUMN "queueName", DROP COLUMN "jobId", DROP COLUMN payload, DROP COLUMN "availableAt", DROP COLUMN "leaseUntil", DROP COLUMN "publishedAt", DROP CONSTRAINT uq_hosting_dispatch_scope')
        await runner.query('ALTER TABLE hosting_dispatch DROP CONSTRAINT chk_hosting_dispatch_state')
        await runner.query('ALTER TABLE hosting_dispatch ADD CONSTRAINT chk_hosting_dispatch_state CHECK (state IN (\'prepared\', \'admitted\', \'running\', \'completed\', \'uncertain\', \'cancelled\'))')
        await runner.query('ALTER TABLE hosting_reservation DROP CONSTRAINT chk_hosting_reservation_state')
        await runner.query('ALTER TABLE hosting_reservation ADD CONSTRAINT chk_hosting_reservation_state CHECK (state IN (\'reserved\', \'running\', \'settled\', \'released\', \'uncertain\'))')
    }
}
