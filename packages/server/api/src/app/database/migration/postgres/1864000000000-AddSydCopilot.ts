import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddSydCopilot1864000000000 implements Migration {
    name = 'AddSydCopilot1864000000000'
    breaking = false
    release = '0.92.0'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE TABLE "syd_conversation" ("id" character varying(21) NOT NULL, "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "platformId" character varying(21) NOT NULL, "userId" character varying(21) NOT NULL, "projectId" character varying(21), "agentId" character varying(21), "flowRunId" character varying(21), "source" character varying NOT NULL DEFAULT \'CHAT\', "title" character varying, "modelName" character varying, "status" character varying NOT NULL DEFAULT \'IDLE\', "activeRunId" character varying, "aiCredits" integer, "messages" jsonb NOT NULL DEFAULT \'[]\'::jsonb, "uiMessages" jsonb, "summary" text, "summarizedUpToIndex" integer, CONSTRAINT "chk_syd_conversation_chat" CHECK (source = \'CHAT\' AND "agentId" IS NULL AND "flowRunId" IS NULL), CONSTRAINT "PK_9717f482fc6e63d26187b2ae409" PRIMARY KEY ("id"))')
        await queryRunner.query('CREATE INDEX "idx_syd_conversation_owner_created" ON "syd_conversation" ("platformId", "userId", "created", "id")')
        await queryRunner.query('CREATE INDEX "idx_syd_conversation_streaming" ON "syd_conversation" ("updated") WHERE status = \'STREAMING\'')
        await queryRunner.query('CREATE TABLE "syd_personalization" ("id" character varying(21) NOT NULL, "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "platformId" character varying(21) NOT NULL, "userId" character varying(21), "domain" character varying, "companyText" character varying, "role" character varying, "status" character varying NOT NULL DEFAULT \'PENDING\', "researchToken" character varying(21), "profile" jsonb, "useCases" jsonb, CONSTRAINT "PK_1e6021ee7ef5c31519d6ee5529a" PRIMARY KEY ("id"))')
        await queryRunner.query('CREATE INDEX "idx_syd_personalization_platform" ON "syd_personalization" ("platformId")')
        await queryRunner.query('CREATE UNIQUE INDEX "idx_syd_personalization_user" ON "syd_personalization" ("platformId", "userId") WHERE "userId" IS NOT NULL')
        await queryRunner.query('CREATE UNIQUE INDEX "idx_syd_personalization_company" ON "syd_personalization" ("platformId") WHERE "userId" IS NULL')
        await queryRunner.query('CREATE TABLE "syd_user_memory" ("id" character varying(21) NOT NULL, "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "platformId" character varying(21) NOT NULL, "userId" character varying(21) NOT NULL, "instructions" text, "memories" jsonb NOT NULL DEFAULT \'[]\'::jsonb, CONSTRAINT "PK_e30719f4a94012ba1a42226cb1c" PRIMARY KEY ("id"))')
        await queryRunner.query('CREATE UNIQUE INDEX "idx_syd_memory_owner" ON "syd_user_memory" ("platformId", "userId")')
        await queryRunner.query('ALTER TABLE "syd_conversation" ADD CONSTRAINT "fk_syd_conversation_platform" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
        await queryRunner.query('ALTER TABLE "syd_conversation" ADD CONSTRAINT "fk_syd_conversation_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
        await queryRunner.query('ALTER TABLE "syd_conversation" ADD CONSTRAINT "fk_syd_conversation_project" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE NO ACTION')
        await queryRunner.query('ALTER TABLE "syd_personalization" ADD CONSTRAINT "fk_syd_personalization_platform" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
        await queryRunner.query('ALTER TABLE "syd_personalization" ADD CONSTRAINT "fk_syd_personalization_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
        await queryRunner.query('ALTER TABLE "syd_user_memory" ADD CONSTRAINT "fk_syd_memory_platform" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
        await queryRunner.query('ALTER TABLE "syd_user_memory" ADD CONSTRAINT "fk_syd_memory_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
        await queryRunner.query('INSERT INTO "syd_conversation" ("id","created","updated","platformId","userId","projectId","agentId","flowRunId","source","title","modelName","status","activeRunId","aiCredits","messages","uiMessages","summary","summarizedUpToIndex") SELECT "id","created","updated","platformId","userId","projectId","agentId","flowRunId","source","title","modelName","status","activeRunId","aiCredits","messages","uiMessages","summary","summarizedUpToIndex" FROM "agent_conversation" WHERE source = \'CHAT\' AND "agentId" IS NULL AND "flowRunId" IS NULL AND id NOT LIKE \'evalconv%\' ON CONFLICT (id) DO NOTHING')
        await queryRunner.query('INSERT INTO "syd_user_memory" (id,created,updated,"platformId","userId",instructions,memories) SELECT id,created,updated,"platformId","userId",instructions,memories FROM "user_memory" ON CONFLICT (id) DO NOTHING')
        await queryRunner.query('INSERT INTO "syd_personalization" (id,created,updated,"platformId","userId",domain,"companyText",role,status,"researchToken",profile,"useCases") SELECT id,created,updated,"platformId","userId",domain,"companyText",role,status,"researchToken",profile,"useCases" FROM "chat_personalization" ON CONFLICT (id) DO NOTHING')
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "syd_user_memory" DROP CONSTRAINT "fk_syd_memory_user"')
        await queryRunner.query('ALTER TABLE "syd_user_memory" DROP CONSTRAINT "fk_syd_memory_platform"')
        await queryRunner.query('ALTER TABLE "syd_personalization" DROP CONSTRAINT "fk_syd_personalization_user"')
        await queryRunner.query('ALTER TABLE "syd_personalization" DROP CONSTRAINT "fk_syd_personalization_platform"')
        await queryRunner.query('ALTER TABLE "syd_conversation" DROP CONSTRAINT "fk_syd_conversation_project"')
        await queryRunner.query('ALTER TABLE "syd_conversation" DROP CONSTRAINT "fk_syd_conversation_user"')
        await queryRunner.query('ALTER TABLE "syd_conversation" DROP CONSTRAINT "fk_syd_conversation_platform"')
        await queryRunner.query('DROP INDEX "public"."idx_syd_memory_owner"')
        await queryRunner.query('DROP TABLE "syd_user_memory"')
        await queryRunner.query('DROP INDEX "public"."idx_syd_personalization_company"')
        await queryRunner.query('DROP INDEX "public"."idx_syd_personalization_user"')
        await queryRunner.query('DROP INDEX "public"."idx_syd_personalization_platform"')
        await queryRunner.query('DROP TABLE "syd_personalization"')
        await queryRunner.query('DROP INDEX "public"."idx_syd_conversation_streaming"')
        await queryRunner.query('DROP INDEX "public"."idx_syd_conversation_owner_created"')
        await queryRunner.query('DROP TABLE "syd_conversation"')
    }

}
