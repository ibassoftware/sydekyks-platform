import { DataSource, QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SydekyksInitialSchema1880000000000 } from '../../../../src/app/database/migration/postgres/1880000000000-SydekyksInitialSchema';
import { SydekyksUpstream1031881000000000 } from '../../../../src/app/database/migration/postgres/1881000000000-SydekyksUpstream103';
import { SydekyksUpstreamOctober211882000000000 } from '../../../../src/app/database/migration/postgres/1882000000000-SydekyksUpstreamOctober21';
import { BackfillPieceTranslation1874000000000 } from '../../../../src/app/database/migration/postgres/background/1874000000000-BackfillPieceTranslation';
import { ReshapeFlowRunListIndexesForBarrierChildren1871000000000 } from '../../../../src/app/database/migration/postgres/background/1871000000000-ReshapeFlowRunListIndexesForBarrierChildren';
import { migrationHelpers } from '../../../../src/app/database/migration-helpers';
import { getMigrations } from '../../../../src/app/database/postgres-connection';

describe.skipIf(process.env.AP_DB_TYPE !== 'POSTGRES')(
  'Sydekyks upstream upgrade on isolated PostgreSQL',
  () => {
    const ds = new DataSource({
      type: 'postgres',
      host: process.env.AP_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.AP_POSTGRES_PORT ?? '5432'),
      username: process.env.AP_POSTGRES_USERNAME,
      password: process.env.AP_POSTGRES_PASSWORD,
      database: process.env.AP_POSTGRES_DATABASE,
      entities: [],
      synchronize: false,
    });
    const schemaName = `sydekyks_upstream_upgrade_${process.pid}`;
    let runner: QueryRunner;

    beforeAll(async () => {
      await ds.initialize();
      await ds.query(
        'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public'
      );
      runner = ds.createQueryRunner();
      await runner.connect();
      await runner.query(`CREATE SCHEMA "${schemaName}"`);
      await runner.query(`SET search_path TO "${schemaName}", public`);

      await new SydekyksInitialSchema1880000000000().up(runner);
      await new SydekyksUpstream1031881000000000().up(runner);
      await runner.query(
        'CREATE TABLE "background_migrations" ("id" BIGSERIAL PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "executed_at" TIMESTAMPTZ, "failed_at" TIMESTAMPTZ, "last_error" TEXT)'
      );
      await runner.query(
        `INSERT INTO "file" ("id", "location", "type", "data") VALUES ('retained-log', 'DB', 'MCP_CALL_PAYLOAD', $1)`,
        [Buffer.from('retained payload')]
      );
      await runner.query(
        `INSERT INTO "piece_metadata" ("id", "name", "authors", "displayName", "logoUrl", "version", "minimumSupportedRelease", "maximumSupportedRelease", "actions", "triggers", "pieceType", "packageType", "i18n") VALUES ('retained-piece', 'retained-gadget', '{}', 'Retained gadget', '', '0.1.0', '0.0.0', '999.0.0', '{}', '{}', 'OFFICIAL', 'REGISTRY', $1)`,
        [JSON.stringify({ fr: { Send: 'Envoyer' } })]
      );
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      if (ds.isInitialized) {
        await runner.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        await runner.release();
        await ds.destroy();
      }
    });

    it('upgrades the released schema, preserves payloads and translations, and can roll back and reapply', async () => {
      vi.spyOn(
        migrationHelpers,
        'withBackgroundMigrationLock'
      ).mockImplementation(async ({ fn }) => fn());
      const migration = new SydekyksUpstreamOctober211882000000000();
      const registered = getMigrations().map((Migration) => new Migration().name);
      expect(registered.slice(0, 3)).toEqual([
        'SydekyksInitialSchema1880000000000',
        'SydekyksUpstream1031881000000000',
        migration.name,
      ]);
      expect(registered[3]).toBe('SydekyksHostingLedger1882000000000');
      await migration.up(runner);
      await migration.up(runner);
      await new BackfillPieceTranslation1874000000000().up(runner);
      await new BackfillPieceTranslation1874000000000().up(runner);
      await new ReshapeFlowRunListIndexesForBarrierChildren1871000000000().up(
        runner
      );
      expect(
        await runner.query(
          'SELECT "translations" FROM "piece_translation" WHERE "pieceMetadataId" = $1 AND "locale" = $2',
          ['retained-piece', 'fr']
        )
      ).toEqual([{ translations: { Send: 'Envoyer' } }]);
      expect(
        await runner.query(
          `SELECT "column_name" FROM information_schema.columns WHERE "table_schema" = $1 AND "table_name" = 'flow_run' AND "column_name" IN ('parentWaitpointId', 'dispatchIndex') ORDER BY "column_name"`,
          [schemaName]
        )
      ).toEqual([
        { column_name: 'dispatchIndex' },
        { column_name: 'parentWaitpointId' },
      ]);
      await migration.down(runner);
      expect(
        await runner.query(
          `SELECT to_regclass('${schemaName}.piece_translation') AS "table"`
        )
      ).toEqual([{ table: null }]);
      await migration.up(runner);
      await new BackfillPieceTranslation1874000000000().up(runner);
      expect(
        await runner.query(
          `SELECT "displayName", "i18n" FROM "piece_metadata" WHERE "id" = 'retained-piece'`
        )
      ).toEqual([
        { displayName: 'Retained gadget', i18n: { fr: { Send: 'Envoyer' } } },
      ]);
      const [file] = await runner.query(
        `SELECT encode("data", 'escape') AS "payload" FROM "file" WHERE "id" = 'retained-log'`
      );
      expect(file.payload).toBe('retained payload');
    });
  }
);
