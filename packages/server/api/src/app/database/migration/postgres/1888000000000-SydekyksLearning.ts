import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class SydekyksLearning1888000000000 implements Migration {
    name = 'SydekyksLearning1888000000000'
    breaking = false
    release = '1.0.9-pilot'
    async up(runner: QueryRunner): Promise<void> {
        await runner.query('CREATE TABLE lms_course (id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(), slug varchar NOT NULL UNIQUE, revision integer NOT NULL CHECK (revision > 0), status varchar NOT NULL CHECK (status IN (\'draft\',\'published\')), content jsonb NOT NULL, "reviewedBy" varchar(21), "reviewedAt" timestamptz)')
        await runner.query('CREATE TABLE lms_enrollment (id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(), "identityId" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, "courseId" varchar(21) NOT NULL REFERENCES lms_course(id) ON DELETE RESTRICT, package varchar NOT NULL CHECK (package IN (\'core\',\'launch\')), "paymentReference" varchar NOT NULL UNIQUE, "workspacePlatformId" varchar(21) REFERENCES platform(id) ON DELETE RESTRICT, "startsAt" timestamptz NOT NULL, "accessUntil" timestamptz NOT NULL, "assessmentUntil" timestamptz NOT NULL, status varchar NOT NULL CHECK (status IN (\'active\',\'revoked\')), "completedLessons" jsonb NOT NULL, assignment jsonb, "practicalReviews" jsonb NOT NULL, "enrolledBy" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT, CONSTRAINT uq_lms_identity_course UNIQUE ("identityId","courseId"), CHECK ("accessUntil" > "startsAt" AND "assessmentUntil" > "startsAt"))')
        await runner.query('CREATE TABLE lms_exam_attempt (id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(), "enrollmentId" varchar(21) NOT NULL REFERENCES lms_enrollment(id) ON DELETE RESTRICT, ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 2), "courseRevision" integer NOT NULL, questions jsonb NOT NULL, answers jsonb NOT NULL, "startedAt" timestamptz NOT NULL, deadline timestamptz NOT NULL, "submittedAt" timestamptz, score integer CHECK (score BETWEEN 0 AND 100), passed boolean, CONSTRAINT uq_lms_attempt_ordinal UNIQUE ("enrollmentId",ordinal), CHECK (deadline > "startedAt"))')
        await runner.query('CREATE TABLE lms_certificate (id varchar(21) PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(), "enrollmentId" varchar(21) NOT NULL UNIQUE REFERENCES lms_enrollment(id) ON DELETE RESTRICT, "verificationToken" varchar NOT NULL UNIQUE, title varchar NOT NULL, "issuedAt" timestamptz NOT NULL, "expiresAt" timestamptz NOT NULL, "revokedAt" timestamptz, "issuedBy" varchar(21) NOT NULL REFERENCES user_identity(id) ON DELETE RESTRICT)')
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE lms_certificate,lms_exam_attempt,lms_enrollment,lms_course IN ACCESS EXCLUSIVE MODE')
        const rows = await runner.query('SELECT id FROM lms_enrollment LIMIT 1')
        if (rows.length) throw new Error('LMS_ROLLBACK_REQUIRES_EMPTY_ENROLLMENTS')
        for (const table of ['lms_certificate', 'lms_exam_attempt', 'lms_enrollment', 'lms_course']) await runner.query(`DROP TABLE ${table}`)
    }
}
