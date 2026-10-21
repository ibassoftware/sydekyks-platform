import { apId } from '@activepieces/core-utils'
import { ExecuteActionJobData, FlowActionType, LATEST_JOB_DATA_SCHEMA_VERSION, WorkerJobType } from '@activepieces/shared'
import { DataSource } from 'typeorm'
import { UserIdentityEntity } from '../../src/app/authentication/user-identity/user-identity-entity'
import { createPGliteDataSource } from '../../src/app/database/pglite-connection'
import { getMigrations } from '../../src/app/database/postgres-connection'
import { createHostedOnboarding } from '../../src/app/hosting/hosting-onboarding'

// Exercise real migrations. PGlite has no ICU provider; only the legacy
// natural-sort collation is substituted, with no financial/auth schema changes.
export async function migratedHostedPGlite(): Promise<DataSource> {
    const ds = new DataSource({ ...createPGliteDataSource().options, synchronize: false, migrations: getMigrations() })
    await ds.initialize()
    const original = ds.createQueryRunner.bind(ds)
    ds.createQueryRunner = (...args) => {
        const runner = original(...args), query = runner.query.bind(runner)
        runner.query = (sql, ...rest) => query(sql.startsWith('CREATE COLLATION IF NOT EXISTS en_natural') ? 'CREATE COLLATION IF NOT EXISTS en_natural FROM "C"' : sql, ...rest)
        return runner
    }
    await ds.runMigrations()
    return ds
}

// This fixture uses the real first-operator bootstrap policy and current token.
// It does not mock the trusted-operator authorization helper.
export async function bootstrapHostedOperator(ds: DataSource, onboarding: ReturnType<typeof createHostedOnboarding>, identityId: string, name = 'Hosted test') {
    const current = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
    const previous = process.env['AP_HOSTED_OPERATOR_IDENTITY_IDS']
    process.env['AP_HOSTED_OPERATOR_IDENTITY_IDS'] = [...new Set([...(previous?.split(',').filter(Boolean) ?? []), identityId])].join(',')
    // Retain all concurrent fixture operators until the owning test cleans its environment.
    try {
        return await onboarding.provision({ identityId, name, expectedTokenVersion: current.tokenVersion ?? null })
    }
    catch (error) {
        if (!(error instanceof Error) || !error.message.includes('HOSTING_SESSION_EXPIRED')) throw error
        // A committed concurrent bootstrap already rotated this identity. This
        // internal idempotency retry does not authenticate the expired session.
        return onboarding.provision({ identityId, name })
    }
}

// Gateway tests use a real supported job shape and persisted payer selection,
// rather than a dispatch with no model authority. Supplier keys stay in the
// normal encrypted AIProvider fixture, never in this immutable action snapshot.
export function scopedAiActionPayload({ platformId, projectId, payer = 'managed', configId }: { platformId: string, projectId: string, payer?: 'managed' | 'byok', configId?: string }) {
    return ExecuteActionJobData.parse({ schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_ACTION, platformId, projectId, requestId: apId(), webserverId: 'synthetic-gateway-fixture', expiresAt: Date.now() + 60_000, step: { name: 'ai_step', type: FlowActionType.PIECE, displayName: 'Synthetic scoped AI', valid: true, lastUpdatedDate: new Date().toISOString(), settings: { pieceName: '@activepieces/piece-ai', pieceVersion: '0.0.1', actionName: 'askAi', propertySettings: {}, input: { provider: payer === 'byok' ? { provider: 'deepseek', configId } : { provider: 'activepieces' }, model: payer === 'byok' ? 'deepseek-flash' : 'sydekyks', prompt: 'Synthetic input' } } } })
}
