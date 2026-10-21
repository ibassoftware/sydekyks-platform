import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksCatalogueTodos1910000000000 implements Migration {
    name = 'SydekyksCatalogueTodos1910000000000'
    breaking = false
    release = '1.0.21'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE catalogue_todo (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "projectId" varchar(21) NOT NULL REFERENCES project(id) ON DELETE CASCADE, "platformId" varchar(21) NOT NULL,
            "flowId" varchar(21) NOT NULL, "runId" varchar(21), title varchar(200) NOT NULL, description varchar(20000) NOT NULL,
            "statusOptions" jsonb NOT NULL, status jsonb, "assigneeId" varchar(21), message varchar(4000),
            "resolvedBy" varchar(21), "resolvedAt" timestamptz, "requestKey" varchar(160) NOT NULL, "requestHash" varchar(64) NOT NULL,
            UNIQUE("projectId", "requestKey")
        )`)
        await runner.query('CREATE INDEX idx_catalogue_todo_project_created ON catalogue_todo ("projectId",created)')
        await runner.query(`CREATE TABLE catalogue_todo_waiter (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "todoId" varchar(21) NOT NULL REFERENCES catalogue_todo(id) ON DELETE CASCADE, "projectId" varchar(21) NOT NULL,
            "flowRunId" varchar(21) NOT NULL, "waitpointId" varchar(21) NOT NULL UNIQUE, "deliveredAt" timestamptz
        )`)
        await runner.query('CREATE INDEX idx_catalogue_todo_waiter_run ON catalogue_todo_waiter ("flowRunId")')
    }
    async down(runner: QueryRunner): Promise<void> {
        const rows = await runner.query('SELECT id FROM catalogue_todo LIMIT 1')
        if (rows.length) throw new Error('TODO_ROLLBACK_REQUIRES_EMPTY_HISTORY')
        await runner.query('DROP TABLE catalogue_todo_waiter')
        await runner.query('DROP TABLE catalogue_todo')
    }
}
