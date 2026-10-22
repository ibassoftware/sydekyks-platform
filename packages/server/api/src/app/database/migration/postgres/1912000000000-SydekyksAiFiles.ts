import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksAiFiles1912000000000 implements Migration {
    name = 'SydekyksAiFiles1912000000000'
    breaking = false
    release = '1.0.21'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE hosting_ai_file (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL, "projectId" varchar(21) NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            "identityId" varchar(21) NOT NULL, name varchar(160) NOT NULL, "mimeType" varchar(100) NOT NULL,
            size integer NOT NULL, "storedBytes" integer NOT NULL, kind varchar(16) NOT NULL, "pageCount" integer NOT NULL,
            "inputTokenBound" integer NOT NULL, "contentHash" varchar(64) NOT NULL, "processorVersion" varchar(80) NOT NULL,
            "cacheKey" varchar(64) UNIQUE, state varchar(16) NOT NULL, "expiresAt" timestamptz NOT NULL, "encryptedData" bytea,
            CHECK(state IN ('ready','deleted','expired')),
            CHECK(size > 0 AND size <= 20971520 AND "storedBytes" >= 0 AND "pageCount" >= 1 AND "pageCount" <= 20 AND "inputTokenBound" >= 0 AND "inputTokenBound" <= 40000)
        )`)
        await runner.query('CREATE INDEX idx_hosting_ai_file_project_identity ON hosting_ai_file ("projectId","identityId",state)')
        await runner.query('CREATE INDEX idx_hosting_ai_file_expiry ON hosting_ai_file (state,"expiresAt")')
    }
    async down(runner: QueryRunner): Promise<void> {
        if ((await runner.query('SELECT id FROM hosting_ai_file WHERE state=\'ready\' LIMIT 1')).length) throw new Error('AI_FILES_ROLLBACK_REQUIRES_NO_ACTIVE_FILES')
        await runner.query('DROP TABLE hosting_ai_file')
    }
}
