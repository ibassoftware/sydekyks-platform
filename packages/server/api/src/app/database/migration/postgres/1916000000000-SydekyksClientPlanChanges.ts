import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksClientPlanChanges1916000000000 implements Migration {
    name = 'SydekyksClientPlanChanges1916000000000'
    breaking = false
    release = '1.0.25'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`ALTER TABLE hosting_stripe_binding ADD COLUMN "pendingPlanId" varchar, ADD COLUMN "pendingChangeAt" timestamptz, ADD COLUMN "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false,
            ADD CONSTRAINT chk_hosting_pending_plan CHECK (("pendingPlanId" IS NULL AND "pendingChangeAt" IS NULL) OR ("pendingPlanId" IS NOT NULL AND "pendingPlanId" IN ('starter','team','scale') AND "pendingChangeAt" IS NOT NULL))`)
        await runner.query('ALTER TABLE hosting_stripe_command DROP CONSTRAINT hosting_stripe_command_kind_check')
        await runner.query('ALTER TABLE hosting_stripe_command ADD CONSTRAINT hosting_stripe_command_kind_check CHECK (kind IN (\'customer\',\'checkout\',\'portal\',\'plan_change\'))')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_stripe_command,hosting_stripe_binding IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_stripe_command WHERE kind=\'plan_change\' UNION ALL SELECT id FROM hosting_stripe_binding WHERE "pendingPlanId" IS NOT NULL OR "cancelAtPeriodEnd" LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_PLAN_CHANGE_ROLLBACK_HAS_EVIDENCE')
        await runner.query('ALTER TABLE hosting_stripe_command DROP CONSTRAINT hosting_stripe_command_kind_check')
        await runner.query('ALTER TABLE hosting_stripe_command ADD CONSTRAINT hosting_stripe_command_kind_check CHECK (kind IN (\'customer\',\'checkout\',\'portal\'))')
        await runner.query('ALTER TABLE hosting_stripe_binding DROP CONSTRAINT chk_hosting_pending_plan, DROP COLUMN "pendingPlanId", DROP COLUMN "pendingChangeAt", DROP COLUMN "cancelAtPeriodEnd"')
    }
}
