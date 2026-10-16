import { createHash, randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { AgentRunSource, EngineResponseStatus, OtpType, ExecuteAgentRunJobData, ExecuteFlowJobData, ExecutionType, FlowRunStatus, FlowVersionState, LATEST_JOB_DATA_SCHEMA_VERSION, PlatformRole, PrincipalType, RunEnvironment, StreamStepProgress, UserIdentityProvider, WorkerJobType } from '@activepieces/shared'
import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { DataSource } from 'typeorm'
import { Job } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticationController } from '../../../../src/app/authentication/authentication.controller'
import { otpService } from '../../../../src/app/authentication/otp/otp-service'
import { authenticationUtils } from '../../../../src/app/authentication/authentication-utils'
import { accessTokenManager } from '../../../../src/app/authentication/lib/access-token-manager'
import { UserIdentityEntity } from '../../../../src/app/authentication/user-identity/user-identity-entity'
import { authenticationMiddleware } from '../../../../src/app/core/security/v2/authn/authentication-middleware'
import { authorizationMiddleware } from '../../../../src/app/core/security/v2/authz/authorization-middleware'
import { commonProperties } from '../../../../src/app/database/database-connection'
import { getMigrations } from '../../../../src/app/database/postgres-connection'
import { FlagEntity } from '../../../../src/app/flags/flag.entity'
import { FlowEntity } from '../../../../src/app/flows/flow/flow.entity'
import { FlowRunEntity } from '../../../../src/app/flows/flow-run/flow-run-entity'
import { FlowVersionEntity } from '../../../../src/app/flows/flow-version/flow-version-entity'
import { errorHandler } from '../../../../src/app/helper/error-handler'
import { hostingController } from '../../../../src/app/hosting/hosting-controller'
import { HostingDispatchEntity } from '../../../../src/app/hosting/hosting-dispatch-entity'
import { HostingAccountEntity, HostingGrantEntity, HostingLedgerEntity, HostingReservationEntity } from '../../../../src/app/hosting/hosting-entities'
import { createHostedExecution } from '../../../../src/app/hosting/hosting-execution'
import { INSTALLATION_MODE_FLAG_ID } from '../../../../src/app/hosting/hosting-installation'
import { createHostedOnboarding } from '../../../../src/app/hosting/hosting-onboarding'
import { createHostedLedger } from '../../../../src/app/hosting/hosting-ledger'
import { hostingServices } from '../../../../src/app/hosting/hosting-services'
import { hostingTransactions } from '../../../../src/app/hosting/hosting-transactions'
import { jwtUtils } from '../../../../src/app/helper/jwt-utils'
import { mcpOAuthTokenService } from '../../../../src/app/mcp/oauth/token/mcp-oauth-token.service'
import { platformController } from '../../../../src/app/platform/platform.controller'
import { platformUtils } from '../../../../src/app/platform/platform.utils'
import { SydConversationEntity } from '../../../../src/app/syd/copilot/models/conversation.entity'
import { UserEntity } from '../../../../src/app/user/user-entity'
import { jobBroker } from '../../../../src/app/workers/job-queue/job-broker'
import { jobQueue, JobType } from '../../../../src/app/workers/job-queue/job-queue'

const { sendOtp } = vi.hoisted(() => ({ sendOtp: vi.fn() }))
vi.mock('../../../../src/app/sydekyks-community/email', () => ({ emailService: () => ({ sendOtp }) }))
const schema = `hosting_wiring_${randomBytes(6).toString('hex')}`
const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(process.env['HOSTING_TEST_POSTGRES_PORT'] ?? '55439'), username: process.env['HOSTING_TEST_POSTGRES_USER'] ?? 'hosting_tests', password: process.env['HOSTING_TEST_POSTGRES_PASSWORD'] ?? 'disposable-only', database: process.env['HOSTING_TEST_POSTGRES_DATABASE'] ?? 'hosting_tests', schema, extra: { options: `-c search_path=${schema},public` }, migrations: getMigrations(), ...commonProperties })
const execution = createHostedExecution({ dataSource: ds })
const onboarding = createHostedOnboarding({ dataSource: ds, subjectSecret: '0123456789abcdef0123456789abcdef' })
let app: FastifyInstance
let previousConnection: unknown
beforeAll(async () => {
    vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    await ds.initialize()
    await ds.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
    const runner = ds.createQueryRunner()
    try { await runner.createSchema(schema, true) }
    finally { await runner.release() }
    await ds.runMigrations({ transaction: 'each' })
    previousConnection = Reflect.get(globalThis, '__AP_DB_CONNECTION__')
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', ds)
    app = fastify()
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    app.setErrorHandler(errorHandler)
    app.addHook('preHandler', authenticationMiddleware)
    app.addHook('preHandler', authorizationMiddleware)
    await app.register(authenticationController, { prefix: '/api/v1/authentication' })
    await app.register(platformController, { prefix: '/api/v1/platforms' })
    await app.register(hostingController, { prefix: '/api/v1/hosting' })
    app.get('/public-tenant', async request => ({ platformId: await platformUtils.getPlatformIdForRequest(request) }))
    await app.ready()
})
afterAll(async () => {
    if (app) { await jobBroker(app.log).close(); await jobQueue(app.log).close(); await app.close() }
    Reflect.set(globalThis, '__AP_DB_CONNECTION__', previousConnection)
    if (ds.isInitialized) { await ds.query(`DROP SCHEMA "${schema}" CASCADE`); await ds.destroy() }
    vi.unstubAllEnvs()
})
beforeEach(async () => {
    await ds.query(`TRUNCATE ${ds.entityMetadatas.map(entity => `"${schema}"."${entity.tableName}"`).join(', ')} CASCADE`)
    await ds.getRepository(FlagEntity).insert({ id: INSTALLATION_MODE_FLAG_ID, value: { schemaVersion: 1, serviceMode: 'hosted' } })
    sendOtp.mockReset()
})
async function identity(verified = true) {
    const id = apId()
    await ds.getRepository(UserIdentityEntity).insert({ id, email: `${id}@example.com`.toLowerCase(), password: 'unused', provider: UserIdentityProvider.EMAIL, verified, firstName: 'Test', lastName: 'User', tokenVersion: 'initial', trackEvents: false, newsLetter: false })
    return id
}
async function tenant() {
    const identityId = await identity()
    const result = await onboarding.provision({ identityId, name: 'Tenant' })
    if (!result.projectId) throw new Error('Missing project')
    const token = await accessTokenManager(app.log).generateToken({ id: result.userId, platform: { id: result.platformId }, type: PrincipalType.USER, tokenVersion: result.tokenVersion })
    return { ...result, projectId: result.projectId, identityId, token, headers: { authorization: `Bearer ${token}` }, actor: { identityId, platformId: result.platformId, tokenVersion: result.tokenVersion } }
}
async function flow() {
    const value = await tenant()
    const flowId = apId(), flowVersionId = apId(), runId = apId()
    await ds.getRepository(FlowEntity).insert({ id: flowId, projectId: value.projectId, externalId: apId() })
    await ds.getRepository(FlowVersionEntity).insert({ id: flowVersionId, flowId, displayName: 'Hosted test', connectionIds: [], agentIds: [], valid: true, state: FlowVersionState.LOCKED, notes: [] })
    const data: ExecuteFlowJobData = { schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, platformId: value.platformId, projectId: value.projectId, jobType: WorkerJobType.EXECUTE_FLOW, flowId, flowVersionId, runId, environment: RunEnvironment.TESTING, executionType: ExecutionType.BEGIN, streamStepProgress: StreamStepProgress.NONE, logsFileId: apId(), payload: { type: 'inline', value: null } }
    await ds.getRepository(FlowRunEntity).insert({ id: runId, flowId, flowVersionId, projectId: value.projectId, triggeredBy: value.userId, environment: RunEnvironment.TESTING, status: FlowRunStatus.QUEUED, tags: [], steps: {} })
    return { ...value, data, delivery: { queueName: `hosting-${schema}`, jobId: runId, data }, origin: { type: 'user' as const, userId: value.userId, tokenVersion: value.tokenVersion } }
}
async function started() {
    const value = await flow()
    await execution.prepare({ ...value.delivery, origin: value.origin })
    const admissionId = await execution.admit({ ...value.delivery, queueToken: 'redis-lock' })
    const fence = { queueName: value.delivery.queueName, jobId: value.delivery.jobId, queueToken: 'redis-lock', connectionId: 'socket-a', admissionId }
    expect(await execution.start({ ...value.delivery, ...fence })).toBe(true)
    return { ...value, fence, admissionId }
}

async function chat() {
    const value = await tenant()
    const runId = apId(), conversationId = apId()
    await ds.getRepository(SydConversationEntity).insert({ id: conversationId, userId: value.userId, platformId: value.platformId, projectId: value.projectId, source: AgentRunSource.CHAT, activeRunId: runId })
    const data: ExecuteAgentRunJobData = { schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_AGENT_RUN, platformId: value.platformId, projectId: value.projectId, conversationId, runId, userId: value.userId, userMessage: 'Test', source: AgentRunSource.CHAT, modelName: null }
    return { ...value, data, delivery: { queueName: `hosting-${schema}-${runId}`, jobId: runId, data }, origin: { type: 'user' as const, userId: value.userId, tokenVersion: value.tokenVersion } }
}
describe('authenticated hosted onboarding', () => {
    it('requires a verified authenticated identity, invalidates onboarding token and mints committed tenant session', async () => {
        expect((await app.inject({ method: 'POST', url: '/api/v1/platforms', payload: { name: 'Forged' } })).statusCode).toBeGreaterThanOrEqual(400)
        const identityId = await identity(false)
        let token = await accessTokenManager(app.log).generateToken({ id: identityId, type: PrincipalType.ONBOARDING, tokenVersion: 'initial' })
        const request = () => app.inject({ method: 'POST', url: '/api/v1/platforms', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Tenant' } })
        expect((await request()).statusCode).toBeGreaterThanOrEqual(400)
        await ds.getRepository(UserIdentityEntity).update({ id: identityId }, { verified: true })
        const response = await request()
        expect(response.statusCode, response.body).toBe(200)
        const result = response.json()
        expect((await accessTokenManager(app.log).verifyPrincipal(result.token)).id).toBe(result.id)
        expect((await request()).statusCode).toBeGreaterThanOrEqual(400)
        token = result.token
        expect((await request()).statusCode).toBeGreaterThanOrEqual(400)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(1)
    })
    it('does not infer the first tenant for anonymous hosted requests or auto-verify CE email signup', async () => {
        await tenant()
        expect((await app.inject('/public-tenant')).json().platformId).toBeNull()
        const email = `${apId()}@example.com`.toLowerCase()
        const response = await app.inject({ method: 'POST', url: '/api/v1/authentication/sign-up', payload: { email, password: 'Valid-password123!', firstName: 'Test', lastName: 'User', newsLetter: false, trackEvents: false } })
        expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400)
        expect((await ds.getRepository(UserIdentityEntity).findOneByOrFail({ email })).verified).toBe(false)
        expect(sendOtp).toHaveBeenCalledTimes(1)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(1)
        const proof = { email, code: sendOtp.mock.calls[0][0].otp, newPassword: 'Owner-password456!' }
        const verified = await app.inject({ method: 'POST', url: '/api/v1/hosting/verify-email', payload: proof })
        expect(verified.statusCode, verified.body).toBe(200)
        expect(verified.json().verified).toBe(true)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(2)
        expect((await app.inject({ method: 'POST', url: '/api/v1/hosting/verify-email', payload: proof })).statusCode).toBeGreaterThanOrEqual(400)
        const oldPassword = await app.inject({ method: 'POST', url: '/api/v1/authentication/sign-in', payload: { email, password: 'Valid-password123!' } })
        expect(oldPassword.statusCode).toBeGreaterThanOrEqual(400)
        const signedIn = await app.inject({ method: 'POST', url: '/api/v1/authentication/sign-in', payload: { email, password: proof.newPassword } })
        expect(signedIn.statusCode, signedIn.body).toBe(200)
        expect(signedIn.json().platformId).toBe(verified.json().platformId)
    })
    it('recovers unverified identities after consumed proof plus database failure without revealing account existence', async () => {
        const identityId = await identity(false)
        const stored = await ds.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId })
        await otpService(app.log).createAndSend({ platformId: null, email: stored.email, type: OtpType.EMAIL_VERIFICATION })
        const old = sendOtp.mock.calls[0][0].otp
        await ds.query('ALTER TABLE user_identity ADD CONSTRAINT test_fail_verify CHECK (verified = false) NOT VALID')
        try {
            const failed = await app.inject({ method: 'POST', url: '/api/v1/hosting/verify-email', payload: { email: stored.email, code: old, newPassword: 'Owner-password456!' } })
            expect(failed.statusCode).toBe(500)
        }
        finally { await ds.query('ALTER TABLE user_identity DROP CONSTRAINT test_fail_verify') }
        const resend = await app.inject({ method: 'POST', url: '/api/v1/hosting/verification-code', payload: { email: stored.email } })
        const absent = await app.inject({ method: 'POST', url: '/api/v1/hosting/verification-code', payload: { email: 'absent@example.com' } })
        expect([resend.statusCode, absent.statusCode]).toEqual([204, 204])
        expect(sendOtp).toHaveBeenCalledTimes(2)
        const result = await app.inject({ method: 'POST', url: '/api/v1/hosting/verify-email', payload: { email: stored.email, code: sendOtp.mock.calls[1][0].otp, newPassword: 'Owner-password456!' } })
        expect(result.statusCode, result.body).toBe(200)
        expect(await ds.getRepository(HostingAccountEntity).count()).toBe(1)
    })
    it('scopes invitations, selection and balances to authenticated membership and refuses identity spoofing', async () => {
        const first = await tenant(), other = await tenant()
        await ds.getRepository(HostingAccountEntity).update({ id: first.platformId }, { planId: 'starter' })
        expect((await app.inject({ url: '/api/v1/hosting/balance', headers: first.headers })).statusCode).toBe(200)
        const denied = await app.inject({ method: 'POST', url: '/api/v1/authentication/switch-platform', headers: other.headers, payload: { platformId: first.platformId } })
        expect(denied.statusCode).toBeGreaterThanOrEqual(400)
        const spoof = await app.inject({ method: 'POST', url: '/api/v1/hosting/invitations', headers: first.headers, payload: { email: 'member@example.com', role: PlatformRole.ADMIN, platformId: other.platformId } })
        expect(spoof.statusCode).toBe(400)
        const invited = await app.inject({ method: 'POST', url: '/api/v1/hosting/invitations', headers: first.headers, payload: { email: 'member@example.com', role: PlatformRole.MEMBER } })
        expect(invited.statusCode, invited.body).toBe(200)
        const memberId = await identity()
        await ds.getRepository(UserIdentityEntity).update({ id: memberId }, { email: 'member@example.com' })
        const token = await accessTokenManager(app.log).generateToken({ id: memberId, type: PrincipalType.ONBOARDING, tokenVersion: 'initial' })
        const accepted = await app.inject({ method: 'POST', url: '/api/v1/hosting/invitations/accept', headers: { authorization: `Bearer ${token}` }, payload: { token: invited.json().token } })
        expect(accepted.statusCode, accepted.body).toBe(200)
        const member = accepted.json()
        expect(member.platformRole).toBe(PlatformRole.MEMBER)
        const attempt = await app.inject({ method: 'PATCH', url: `/api/v1/hosting/members/${first.userId}`, headers: { authorization: `Bearer ${member.token}` }, payload: { role: PlatformRole.MEMBER } })
        expect(attempt.statusCode).toBe(403)
        await app.inject({ method: 'PATCH', url: `/api/v1/hosting/members/${member.id}`, headers: first.headers, payload: { deactivate: true } })
        expect((await app.inject({ url: '/api/v1/hosting/balance', headers: { authorization: `Bearer ${member.token}` } })).statusCode).toBeGreaterThanOrEqual(400)
    })
    it('cannot mint a replacement session from a stale transaction receipt', async () => {
        const value = await tenant()
        await ds.getRepository(UserIdentityEntity).update({ id: value.identityId }, { tokenVersion: 'revoked' })
        await expect(authenticationUtils(app.log).getProjectAndToken({ ...value, expectedTokenVersion: value.tokenVersion })).rejects.toThrow()
        await expect(onboarding.selectTenant({ actor: value.actor })).rejects.toThrow('HOSTING_ACCESS_DENIED')
    })
    it('uses DB MCP revocation immediately and rejects grantless hosted tokens', async () => {
        const value = await tenant()
        const internal = await mcpOAuthTokenService.issueInternalAccessToken({ userId: value.userId, platformId: value.platformId, projectId: value.projectId })
        expect((await mcpOAuthTokenService.authenticate({ token: internal, log: app.log })).status).toBe('invalid')
        const token = await mcpOAuthTokenService.exchangeCode({ userId: value.userId, projectId: value.projectId, platformId: value.platformId, clientId: 'test-client', redirectUris: [], scopes: [], codeVerifier: 'plain-verifier', codeChallenge: createHash('sha256').update('plain-verifier').digest('base64url'), codeChallengeMethod: 'S256' })
        expect((await mcpOAuthTokenService.authenticate({ token: token.access_token, log: app.log })).status).toBe('ok')
        await onboarding.changeMember({ actor: value.actor, userId: value.userId, role: PlatformRole.ADMIN })
        expect((await mcpOAuthTokenService.authenticate({ token: token.access_token, log: app.log })).status).toBe('invalid')
    })
})

describe('durable hosted execution coordinator', () => {
    it('reserves one credit/slot atomically and claims once across competing starts', async () => {
        const value = await flow()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const admissionId = await execution.admit({ ...value.delivery, queueToken: 'redis-lock' })
        const starts = await Promise.all(Array.from({ length: 8 }, () => execution.start({ ...value.delivery, queueToken: 'redis-lock', connectionId: 'a', admissionId })))
        expect(starts.filter(Boolean)).toHaveLength(1)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).consumed).toBe(1n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
    })
    it.each(['receipt-first', 'completion-first'])('joins fenced terminal receipt and completion in either order: %s', async order => {
        const value = await started()
        const receipt = () => execution.flowReceipt({ admissionId: value.admissionId, projectId: value.projectId, runId: value.data.runId, status: FlowRunStatus.SUCCEEDED })
        const complete = () => execution.complete({ ...value.fence, status: EngineResponseStatus.OK })
        await (order === 'receipt-first' ? receipt() : complete())
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
        await (order === 'receipt-first' ? complete() : receipt())
        await complete()
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        await expect(execution.admit({ ...value.delivery, queueToken: 'redelivered' })).rejects.toThrow('HOSTING_REPLAY_DENIED')
    })
    it('rejects forged payload, wrong connection, wrong queue lock and foreign callback', async () => {
        const value = await started()
        await expect(execution.complete({ ...value.fence, connectionId: 'other', status: EngineResponseStatus.OK })).rejects.toThrow('HOSTING_DISPATCH_FENCE_MISMATCH')
        await expect(execution.complete({ ...value.fence, queueToken: 'stale', status: EngineResponseStatus.OK })).rejects.toThrow('HOSTING_DISPATCH_FENCE_MISMATCH')
        await expect(execution.flowReceipt({ admissionId: value.admissionId, projectId: apId(), runId: value.data.runId, status: FlowRunStatus.SUCCEEDED })).rejects.toThrow('HOSTING_DISPATCH_FENCE_MISMATCH')
        await expect(execution.prepare({ ...value.delivery, data: { ...value.data, payload: { type: 'inline', value: 'changed' } }, origin: value.origin })).rejects.toThrow('HOSTING_IDEMPOTENCY_CONFLICT')
    })
    it('releases cancellation before dispatch and never refunds or resends uncertain work', async () => {
        const value = await flow()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const admissionId = await execution.admit({ ...value.delivery, queueToken: 'unsent' })
        await execution.cancel(value.delivery)
        expect(await execution.start({ ...value.delivery, admissionId, queueToken: 'unsent', connectionId: 'a' })).toBe(false)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        const running = await started()
        await execution.disconnect({ ...running.delivery, admissionId: running.admissionId })
        await expect(execution.admit({ ...running.delivery, queueToken: 'retry' })).rejects.toThrow('HOSTING_REPLAY_DENIED')
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ platformId: running.platformId })).state).toBe('uncertain')
    })
    it('lets unsent deliveries recover after disconnect but keeps the old admission fenced out', async () => {
        const value = await flow()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const old = await execution.admit({ ...value.delivery, queueToken: 'old' })
        await execution.disconnect({ ...value.delivery, admissionId: old })
        const next = await execution.admit({ ...value.delivery, queueToken: 'next' })
        expect(await execution.start({ ...value.delivery, admissionId: old, queueToken: 'old', connectionId: 'old' })).toBe(false)
        expect(await execution.start({ ...value.delivery, admissionId: next, queueToken: 'next', connectionId: 'next' })).toBe(true)
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(1)
    })
    it('rechecks membership/session and entitlement on admission and start', async () => {
        const value = await flow()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        await ds.getRepository(UserIdentityEntity).update({ id: value.identityId }, { tokenVersion: 'revoked' })
        await expect(execution.admit({ ...value.delivery, queueToken: 'a' })).rejects.toThrow('HOSTING_ACCESS_DENIED')
        const other = await flow()
        await execution.prepare({ ...other.delivery, origin: other.origin })
        const admissionId = await execution.admit({ ...other.delivery, queueToken: 'b' })
        await ds.getRepository(HostingAccountEntity).update({ id: other.platformId }, { validUntil: new Date(0) })
        expect(await execution.start({ ...other.delivery, admissionId, queueToken: 'b', connectionId: 'a' })).toBe(false)
        expect((await ds.getRepository(HostingReservationEntity).findOneByOrFail({ platformId: other.platformId })).state).toBe('released')
    })
    it('denies all hosted jobs without prepared provenance and unsupported paths', async () => {
        const value = await flow()
        await expect(execution.admit({ ...value.delivery, queueToken: 'a' })).rejects.toThrow('HOSTING_JOB_PROVENANCE_REQUIRED')
        await expect(execution.prepare(value.delivery)).rejects.toThrow('HOSTING_JOB_PROVENANCE_REQUIRED')
        await expect(execution.prepare({ ...value.delivery, data: { ...value.data, jobType: WorkerJobType.EXECUTE_POLLING, triggerType: 'PIECE_TRIGGER' } })).rejects.toThrow()
        await expect(jobQueue(app.log).add({ id: apId(), type: JobType.ONE_TIME, data: { ...value.data, executionType: ExecutionType.RESUME, resumeReason: 'RETRY' } })).rejects.toThrow('HOSTING_SEGMENT_COORDINATOR_REQUIRED')
    })
    it('rolls back reservation and binding admission together when a write fails', async () => {
        const value = await flow()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        await ds.query("ALTER TABLE hosting_dispatch ADD CONSTRAINT test_fail_admit CHECK (state <> 'admitted') NOT VALID")
        try { await expect(execution.admit({ ...value.delivery, queueToken: 'a' })).rejects.toThrow() }
        finally { await ds.query('ALTER TABLE hosting_dispatch DROP CONSTRAINT test_fail_admit') }
        expect(await ds.getRepository(HostingReservationEntity).countBy({ platformId: value.platformId })).toBe(0)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        await expect(hostingTransactions.run({ dataSource: ds, manager: ds.manager, fn: async () => true })).rejects.toThrow('HOSTING_TRANSACTION_REQUIRED')
    })
    it('holds paused and internal-error outcomes for explicit recovery', async () => {
        const value = await started()
        await execution.flowReceipt({ admissionId: value.admissionId, projectId: value.projectId, runId: value.data.runId, status: FlowRunStatus.PAUSED })
        await execution.complete({ ...value.fence, status: EngineResponseStatus.OK })
        expect((await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: value.admissionId })).state).toBe('uncertain')
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
    })
    it.each(['revoked-flow', 'superseded-chat'])('releases known-unsent work denied at real broker start: %s', async kind => {
        const value = kind === 'revoked-flow' ? await flow() : await chat()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const queue = await jobQueue(app.log).getOrCreateQueue({ queueName: value.delivery.queueName })
        const job = await queue.add(value.delivery.jobId, value.data, { jobId: value.delivery.jobId })
        const delivered = await jobBroker(app.log).poll(queue.name, 'socket-denied')
        if (!delivered) throw new Error('Missing delivery')
        if (kind === 'revoked-flow') await ds.getRepository(UserIdentityEntity).update({ id: value.identityId }, { tokenVersion: 'revoked' })
        else if (value.data.jobType === WorkerJobType.EXECUTE_AGENT_RUN) await ds.getRepository(SydConversationEntity).update({ id: value.data.conversationId }, { activeRunId: apId() })
        expect(await jobBroker(app.log).startJob(delivered, 'socket-denied')).toBe(false)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        const grant = await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })
        expect([grant.reserved, grant.consumed]).toEqual([0n, 0n])
        await job.moveToDelayed(Date.now() - 1, delivered.token)
        const deniedPoll = jobBroker(app.log).poll(queue.name, 'socket-next')
        await vi.waitFor(async () => expect(await job.getState()).toBe('failed'))
        await jobBroker(app.log).close()
        expect(await deniedPoll).toBeNull()
        await jobBroker(app.log).releaseConnectionJobs('socket-denied')
        await queue.obliterate({ force: true })
    })
    it('cancels stale admitted redelivery and preserves prepared actor identity across logout', async () => {
        const value = await flow()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const first = await execution.admit({ ...value.delivery, queueToken: 'old' })
        await execution.disconnect({ ...value.delivery, admissionId: first })
        await ds.getRepository(UserIdentityEntity).update({ id: value.identityId }, { tokenVersion: 'revoked' })
        await expect(execution.admit({ ...value.delivery, queueToken: 'new' })).rejects.toThrow('HOSTING_ACCESS_DENIED')
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('persists root completion receipts while children settle and reconciles once afterward', async () => {
        const value = await started()
        const dispatch = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: value.admissionId })
        const ledger = createHostedLedger({ dataSource: ds })
        const child = await ledger.reserveManagedCall({ actor: value.actor, rootReservationId: dispatch.reservationId ?? '', key: 'child', maxCostMicroUsd: 100n })
        const claim = await ledger.claimManagedCall({ actor: value.actor, reservationId: child.id })
        if (!claim.dispatchId) throw new Error('Missing child fence')
        await execution.complete({ ...value.fence, status: EngineResponseStatus.OK })
        await execution.flowReceipt({ admissionId: value.admissionId, projectId: value.projectId, runId: value.data.runId, status: FlowRunStatus.SUCCEEDED })
        const pending = await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ id: dispatch.id })
        expect([pending.completionStatus, pending.terminalReceipt]).toEqual([EngineResponseStatus.OK, FlowRunStatus.SUCCEEDED])
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
        await ledger.settleManagedCall({ platformId: value.platformId, reservationId: child.id, dispatchId: claim.dispatchId, actualCostMicroUsd: 25n })
        await execution.reconcile({ platformId: value.platformId, dispatchId: dispatch.id })
        await execution.reconcile({ platformId: value.platformId, dispatchId: dispatch.id })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('uses persisted CHAT ownership/run and denies duplicate roots on a fresh queue id', async () => {
        const value = await chat()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        await expect(execution.prepare({ ...value.delivery, jobId: apId(), origin: value.origin })).rejects.toThrow('HOSTING_SEGMENT_COORDINATOR_REQUIRED')
        const other = await tenant()
        await expect(execution.prepare({ ...value.delivery, jobId: apId(), data: { ...value.data, userId: other.userId }, origin: { ...value.origin, userId: other.userId } })).rejects.toThrow('HOSTING_JOB_PROVENANCE_REQUIRED')
        const admissionId = await execution.admit({ ...value.delivery, queueToken: 'chat' })
        expect(await execution.start({ ...value.delivery, admissionId, queueToken: 'chat', connectionId: 'socket-chat' })).toBe(true)
        await execution.complete({ ...value.delivery, admissionId, queueToken: 'chat', connectionId: 'socket-chat', status: EngineResponseStatus.OK })
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
    })
    it('checks flow origin, scope and nested work without substituting another owner', async () => {
        const value = await flow()
        await expect(execution.prepare({ ...value.delivery, origin: { type: 'scheduled' } })).rejects.toThrow('HOSTING_JOB_PROVENANCE_REQUIRED')
        await ds.getRepository(FlowRunEntity).update({ id: value.data.runId }, { parentRunId: apId() })
        await expect(execution.prepare({ ...value.delivery, origin: value.origin })).rejects.toThrow('HOSTING_NESTED_COORDINATOR_REQUIRED')
    })
    it('keeps execution charged and completed after Redis acknowledgement failure and redelivery', async () => {
        const value = await chat()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const queue = await jobQueue(app.log).getOrCreateQueue({ queueName: value.delivery.queueName })
        await queue.add(value.delivery.jobId, value.data, { jobId: value.delivery.jobId })
        const delivered = await jobBroker(app.log).poll(queue.name, 'socket-ack')
        if (!delivered) throw new Error('Missing delivery')
        expect(await jobBroker(app.log).startJob(delivered, 'socket-ack')).toBe(true)
        const ack = vi.spyOn(Job.prototype, 'moveToCompleted').mockRejectedValueOnce(new Error('synthetic ack failure'))
        try { await jobBroker(app.log).completeJob({ ...delivered, status: EngineResponseStatus.OK }, 'socket-ack') }
        finally { ack.mockRestore() }
        expect((await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: delivered.admissionId })).state).toBe('completed')
        expect(await jobBroker(app.log).startJob(delivered, 'socket-ack')).toBe(false)
        await jobBroker(app.log).completeJob({ ...delivered, status: EngineResponseStatus.OK }, 'socket-ack')
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).consumed).toBe(1n)
        await queue.obliterate({ force: true })
    })
    it('retries transient admission failure through the real broker without an extra charge', async () => {
        const value = await chat()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const queue = await jobQueue(app.log).getOrCreateQueue({ queueName: value.delivery.queueName })
        await queue.add(value.delivery.jobId, value.data, { jobId: value.delivery.jobId })
        const adapter = createHostedExecution({ dataSource: ds })
        const originalAdmission = adapter.admit.bind(adapter)
        const admit = vi.spyOn(adapter, 'admit').mockImplementationOnce(async params => { await originalAdmission(params); throw new Error('synthetic connection loss after commit') })
        const factory = vi.spyOn(hostingServices, 'execution').mockReturnValue(adapter)
        try {
            const delivered = await jobBroker(app.log).poll(queue.name, 'socket-recovery')
            if (!delivered) throw new Error('Missing delivery')
            expect(admit).toHaveBeenCalledTimes(2)
            expect(await jobBroker(app.log).startJob(delivered, 'socket-recovery')).toBe(true)
            await jobBroker(app.log).completeJob({ ...delivered, status: EngineResponseStatus.OK }, 'socket-recovery')
            expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).consumed).toBe(1n)
        }
        finally { factory.mockRestore(); admit.mockRestore(); await queue.obliterate({ force: true }) }
    })
    it('rechecks callback admission after waiting for the account lock during rebind', async () => {
        const value = await flow()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const old = await execution.admit({ ...value.delivery, queueToken: 'old' })
        let enter = () => {}, unblock = () => {}
        const entered = new Promise<void>(resolve => { enter = resolve })
        const gate = new Promise<void>(resolve => { unblock = resolve })
        const lock = hostingTransactions.account
        const barrier = vi.spyOn(hostingTransactions, 'account').mockImplementationOnce(async params => { enter(); await gate; return lock(params) })
        const receipt = execution.flowReceipt({ admissionId: old, projectId: value.projectId, runId: value.data.runId, status: FlowRunStatus.SUCCEEDED })
        const denied = expect(receipt).rejects.toThrow('HOSTING_DISPATCH_FENCE_MISMATCH')
        try {
            await entered
            await execution.disconnect({ ...value.delivery, admissionId: old })
            const admissionId = await execution.admit({ ...value.delivery, queueToken: 'next' })
            expect(await execution.start({ ...value.delivery, admissionId, queueToken: 'next', connectionId: 'next' })).toBe(true)
            unblock()
            await denied
        }
        finally { unblock(); barrier.mockRestore() }
    })
    it('keeps a started broker delivery uncertain on disconnect without returning it to the queue', async () => {
        const value = await chat()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const queue = await jobQueue(app.log).getOrCreateQueue({ queueName: value.delivery.queueName })
        const job = await queue.add(value.delivery.jobId, value.data, { jobId: value.delivery.jobId })
        const delivered = await jobBroker(app.log).poll(queue.name, 'socket-lost')
        if (!delivered) throw new Error('Missing delivery')
        expect(await jobBroker(app.log).startJob(delivered, 'socket-lost')).toBe(true)
        await jobBroker(app.log).releaseConnectionJobs('socket-lost')
        expect(await job.getState()).toBe('active')
        expect((await ds.getRepository(HostingDispatchEntity).findOneByOrFail({ admissionId: delivered.admissionId })).state).toBe('uncertain')
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).consumed).toBe(1n)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(1)
        await queue.obliterate({ force: true })
    })
    it('releases admitted unsent credit when a queued payload becomes malformed', async () => {
        const value = await chat()
        await execution.prepare({ ...value.delivery, origin: value.origin })
        const queue = await jobQueue(app.log).getOrCreateQueue({ queueName: value.delivery.queueName })
        const job = await queue.add(value.delivery.jobId, value.data, { jobId: value.delivery.jobId })
        const delivered = await jobBroker(app.log).poll(queue.name, 'socket-malformed')
        if (!delivered) throw new Error('Missing delivery')
        await job.updateData({ ...value.data, jobType: 'MALFORMED' })
        expect(await jobBroker(app.log).startJob(delivered, 'socket-malformed')).toBe(false)
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        expect((await ds.getRepository(HostingGrantEntity).findOneByOrFail({ platformId: value.platformId, meter: 'execution' })).reserved).toBe(0n)
        await jobBroker(app.log).releaseConnectionJobs('socket-malformed')
        await queue.obliterate({ force: true })
    })
    it('gates real BullMQ enqueue, poll, start and completion through durable accounting', async () => {
        const value = await flow()
        const job = await jobQueue(app.log).add({ id: value.data.runId, type: JobType.ONE_TIME, data: value.data, hostedOrigin: value.origin })
        if (!job) throw new Error('Missing job')
        const delivered = await jobBroker(app.log).poll(job.queueName, 'socket-real')
        if (!delivered) throw new Error('Missing delivery')
        const enginePrincipal = await jwtUtils.decodeAndVerify<{ id: string }>({ jwt: delivered.engineToken, key: await jwtUtils.getJwtSecret() })
        expect(enginePrincipal.id).toBe(delivered.admissionId)
        expect(await jobBroker(app.log).startJob(delivered, 'wrong-socket')).toBe(false)
        expect(await jobBroker(app.log).startJob(delivered, 'socket-real')).toBe(true)
        expect(await jobBroker(app.log).startJob(delivered, 'socket-real')).toBe(false)
        await execution.flowReceipt({ admissionId: delivered.admissionId, projectId: value.projectId, runId: value.data.runId, status: FlowRunStatus.SUCCEEDED })
        await jobBroker(app.log).completeJob({ ...delivered, status: EngineResponseStatus.OK }, 'socket-real')
        expect((await ds.getRepository(HostingAccountEntity).findOneByOrFail({ id: value.platformId })).activeExecutions).toBe(0)
        await job.queue.obliterate({ force: true })
    })
})
