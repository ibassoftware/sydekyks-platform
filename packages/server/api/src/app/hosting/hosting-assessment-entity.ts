import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type HostingAssessment = {
    id: string
    created: Date
    updated: Date
    platformId: string
    identityId: string
    enrollmentId: string
    trainingId: string
    operatorIdentityId: string
    startsAt: Date
    endsAt: Date
    revokedAt: Date | null
}

// A paid Core enrollment can receive only one bounded assessment allowance.
// Original training grants and their audit history are never rewritten.
export const HostingAssessmentEntity = new EntitySchema<HostingAssessment>({
    name: 'hosting_assessment',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: ApIdSchema, identityId: ApIdSchema, enrollmentId: ApIdSchema,
        trainingId: ApIdSchema, operatorIdentityId: ApIdSchema,
        startsAt: { type: 'timestamptz' }, endsAt: { type: 'timestamptz' }, revokedAt: { type: 'timestamptz', nullable: true },
    },
    uniques: [{ columns: ['platformId'] }, { columns: ['enrollmentId'] }, { columns: ['trainingId'] }],
    checks: [{ expression: '"endsAt" > "startsAt"' }],
    foreignKeys: [
        { target: 'hosting_account', columnNames: ['platformId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'hosting_training', columnNames: ['trainingId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        { target: 'lms_enrollment', columnNames: ['enrollmentId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
    ],
})
