import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksHostingAccess1887000000000 implements Migration {
    name = 'SydekyksHostingAccess1887000000000'
    breaking = false
    release = '0.93.0-sydekyks.9'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE hosting_access_role (
            id varchar(21) PRIMARY KEY REFERENCES user_identity(id) ON DELETE RESTRICT,
            created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            role varchar NOT NULL CHECK (role IN ('partner','team')), active boolean NOT NULL)`)
        await runner.query(`CREATE TABLE hosting_access_membership (
            id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(),
            "platformId" varchar(21) NOT NULL REFERENCES hosting_account(id) ON DELETE RESTRICT,
            "identityId" varchar(21) NOT NULL REFERENCES hosting_access_role(id) ON DELETE RESTRICT,
            "userId" varchar(21) NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE RESTRICT,
            role varchar NOT NULL CHECK (role IN ('partner','team')), active boolean NOT NULL,
            UNIQUE ("platformId", "identityId"))`)
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE hosting_access_role,hosting_access_membership IN ACCESS EXCLUSIVE MODE')
        const rows: unknown = await runner.query('SELECT id FROM hosting_access_role UNION ALL SELECT id FROM hosting_access_membership LIMIT 1')
        if (!Array.isArray(rows) || rows.length) throw new Error('HOSTING_ACCESS_ROLLBACK_REQUIRES_EMPTY_TABLES')
        await runner.query('DROP TABLE hosting_access_membership')
        await runner.query('DROP TABLE hosting_access_role')
    }
}
