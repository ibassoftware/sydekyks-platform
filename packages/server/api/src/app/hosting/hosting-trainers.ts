import { createHash, randomBytes } from 'node:crypto'
import { apId } from '@activepieces/core-utils'
import { cryptoUtils } from '@activepieces/server-utils'
import { MAX_FULL_NAME_LENGTH, PasswordType, PlatformRole, UserIdentityProvider, UserStatus } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { DataSource, EntityManager, IsNull } from 'typeorm'
import { z } from 'zod'
import { passwordHasher } from '../authentication/lib/password-hasher'
import { signupNames } from '../authentication/lib/signup-names'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { McpOAuthTokenEntity } from '../mcp/oauth/token/mcp-oauth-token.entity'
import { PlatformEntity } from '../platform/platform.entity'
import { UserEntity } from '../user/user-entity'
import { HostingAccessRoleEntity } from './hosting-access-entities'
import { assertHostingOperator, hostingOperatorIdentityIds, isOperationalUser } from './hosting-access-policy'
import { HostingAccountEntity } from './hosting-entities'
import { createHostedOnboarding } from './hosting-onboarding'
import { HostingTrainerAssignmentEntity, HostingTrainerCommandEntity, HostingTrainerRoleEntity, HostingTrainerSetupEntity, TrainerAssignment } from './hosting-trainer-entities'
import { assertPlatformTrainer, assertTrainerClient, assertTrainerProvisioning, listTrainerClients, listTrainerLearners, trainerExternalId } from './hosting-trainer-policy'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

const id = z.string().length(21), revision = z.number().int().min(0).max(10000)
const cas = z.object({ expectedRevision: revision, expectedState: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/) })
export const TrainerDecision = cas.extend({ trainerIdentityId: id, active: z.boolean() }).strict()
export const TrainerAssign = cas.extend({ trainerIdentityId: id, assignmentId: id.optional(), kind: z.enum(['partner', 'client']).optional(), targetId: id.optional(), active: z.boolean() }).strict().refine(value => !!value.assignmentId || !!value.kind && !!value.targetId)
export const TrainerOnboard = cas.extend({ email: z.email().max(254).transform(value => value.trim().toLowerCase()), kind: z.enum(['partner', 'client']), workspaceName: z.string().trim().min(1).max(120) }).strict()
export const TrainerSetupChange = cas.extend({ assignmentId: id }).strict()
export const TrainerSecret = z.string().regex(/^[a-zA-Z0-9_-]{43}$/)
export const TrainerRedeem = z.strictObject({ token: TrainerSecret, password: PasswordType, fullName: z.string().trim().min(1).max(MAX_FULL_NAME_LENGTH) })

export function createPlatformTrainers({ dataSource, onboarding, log }: { dataSource: DataSource, onboarding: ReturnType<typeof createHostedOnboarding>, log: FastifyBaseLogger }) {
    async function adminList({ actor, email }: { actor: HostingActor, email?: string }) {
        return tx.run({ dataSource, fn: async manager => {
            const operator = await assertHostingOperator({ manager, actor })
            if (email) {
                const identity = await manager.getRepository(UserIdentityEntity).findOneBy({ email: email.trim().toLowerCase() })
                return { platformId: actor.platformId, userId: operator.id, trainers: identity ? [await adminView(manager, identity.id)] : [] }
            }
            const rows = await manager.getRepository(HostingTrainerRoleEntity).find({ order: { created: 'ASC' }, take: 100 })
            return { platformId: actor.platformId, userId: operator.id, trainers: await Promise.all(rows.map(row => adminView(manager, row.id))) }
        } })
    }
    async function adminCommand({ actor, input, action }: { actor: HostingActor, input: z.infer<typeof TrainerDecision> | z.infer<typeof TrainerAssign>, action: 'role' | 'assignment' }) {
        const value = action === 'role' ? TrainerDecision.parse(input) : TrainerAssign.parse(input), requestHash = hash({ action, value })
        return tx.run({ dataSource, fn: async manager => {
            await assertHostingOperator({ manager, actor })
            const target = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: value.trainerIdentityId }, lock: { mode: 'pessimistic_write' } })
            if (!target?.verified || target.id === actor.identityId || hostingOperatorIdentityIds().includes(target.id) || await manager.getRepository(HostingAccessRoleEntity).existsBy({ id: target.id, role: 'team' })) hostingFail('HOSTING_TRAINER_IDENTITY_PROTECTED')
            let role = await manager.getRepository(HostingTrainerRoleEntity).findOne({ where: { id: target.id }, lock: { mode: 'pessimistic_write' } })
            const current = await adminView(manager, target.id)
            await assertHostingOperator({ manager, actor })
            const prior = await manager.getRepository(HostingTrainerCommandEntity).findOneBy({ actorIdentityId: actor.identityId, requestKey: value.requestKey })
            if (prior) {
                if (prior.requestHash !== requestHash) hostingFail('HOSTING_TRAINER_IDEMPOTENCY_CONFLICT')
                return { platformId: actor.platformId, userId: (await assertHostingOperator({ manager, actor })).id, trainer: current, replayed: true }
            }
            assertCas(current, value)
            if (!role) {
                if (action !== 'role' || !value.active || !await manager.getRepository(UserEntity).existsBy({ identityId: target.id, status: UserStatus.ACTIVE })) hostingFail('HOSTING_TRAINER_NORMAL_ACCOUNT_REQUIRED')
                role = await manager.getRepository(HostingTrainerRoleEntity).save({ id: target.id, active: true, revision: 0, accessVersion: 1 })
            }
            let details: Record<string, unknown>
            if (action === 'role') {
                if (role.active !== value.active) role.accessVersion++
                role.active = value.active
                if (!value.active) for (const assignment of await manager.getRepository(HostingTrainerAssignmentEntity).findBy({ trainerIdentityId: role.id, active: true })) await deactivateAssignment(manager, assignment)
                await revokeTrainerSessions(manager, role.id)
                details = { active: role.active, accessVersion: role.accessVersion }
            }
            else {
                if (!role.active) hostingFail('HOSTING_TRAINER_REQUIRED')
                const assign = TrainerAssign.parse(value)
                let existing = assign.assignmentId ? await manager.getRepository(HostingTrainerAssignmentEntity).findOneBy({ id: assign.assignmentId, trainerIdentityId: role.id }) : await manager.getRepository(HostingTrainerAssignmentEntity).findOneBy({ trainerIdentityId: role.id, ...(assign.kind === 'partner' ? { partnerIdentityId: assign.targetId! } : { clientPlatformId: assign.targetId! }) })
                if (assign.assignmentId && !existing) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
                if (!assign.active) {
                    if (!existing) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
                    await deactivateAssignment(manager, existing); await revokeTrainerSessions(manager, role.id)
                }
                else if (existing?.kind === 'recipient') hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
                else {
                    const kind = existing?.kind ?? assign.kind!, targetId = kind === 'partner' ? existing?.partnerIdentityId ?? assign.targetId! : existing?.clientPlatformId ?? assign.targetId!
                    if (kind === 'partner') {
                        const partner = await manager.getRepository(UserIdentityEntity).findOneBy({ id: targetId, verified: true })
                        if (!partner || partner.id === role.id || hostingOperatorIdentityIds().includes(partner.id) || await manager.getRepository(HostingAccessRoleEntity).existsBy({ id: partner.id, role: 'team' })) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
                    }
                    else if (!await manager.getRepository(HostingAccountEntity).existsBy({ id: targetId })) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
                    existing = await manager.getRepository(HostingTrainerAssignmentEntity).save({ id: existing?.id ?? apId(), trainerIdentityId: role.id, kind, partnerIdentityId: kind === 'partner' ? targetId : null, clientPlatformId: kind === 'client' ? targetId : null, active: true, revision: (existing?.revision ?? 0) + 1, provenance: existing?.provenance ?? 'operator', createdByIdentityId: existing?.createdByIdentityId ?? actor.identityId, userId: existing?.userId ?? null })
                    if (kind === 'client') await materializeClient(manager, existing)
                }
                details = { assignmentId: existing!.id, active: assign.active }
            }
            role.revision++
            await manager.getRepository(HostingTrainerRoleEntity).save(role)
            await history(manager, actor, role.id, role.revision, value.requestKey, requestHash, action, details)
            return { platformId: actor.platformId, userId: (await assertHostingOperator({ manager, actor })).id, trainer: await adminView(manager, role.id), replayed: false }
        } })
    }
    async function portfolio({ actor }: { actor: HostingActor }) {
        return tx.run({ dataSource, fn: async manager => portfolioView(manager, actor) })
    }
    async function learners({ actor, audience = 'end_user', platformId }: { actor: HostingActor, audience?: 'partner' | 'end_user', platformId?: string }) {
        return tx.run({ dataSource, fn: async manager => ({ platformId: actor.platformId, userId: (await assertPlatformTrainer({ manager, actor })).user.id, learners: await listTrainerLearners({ manager, actor, audience, platformId }) }) })
    }
    async function onboard({ actor, input }: { actor: HostingActor, input: z.infer<typeof TrainerOnboard> }) {
        const value = TrainerOnboard.parse(input), requestHash = hash({ action: 'onboard', value })
        return tx.run({ dataSource, fn: async manager => {
            const authority = await assertPlatformTrainer({ manager, actor })
            const prior = await manager.getRepository(HostingTrainerCommandEntity).findOneBy({ actorIdentityId: actor.identityId, requestKey: value.requestKey })
            if (prior) {
                if (prior.requestHash !== requestHash) hostingFail('HOSTING_TRAINER_IDEMPOTENCY_CONFLICT')
                return { ...await portfolioView(manager, actor), setupUrl: null, replayed: true }
            }
            assertCas(await trainerFence(manager, actor.identityId), value)
            // No existing email, even unfinished/unverified, can be claimed by a trainer.
            if (await manager.getRepository(UserIdentityEntity).existsBy({ email: value.email })) hostingFail('HOSTING_TRAINER_ONBOARDING_UNAVAILABLE')
            const identity = await userIdentityService(log).create({ email: value.email, password: await cryptoUtils.generateRandomPassword(), firstName: signupNames.firstNameFromEmail(value.email), lastName: '', provider: UserIdentityProvider.EMAIL, verified: false, trackEvents: false, newsLetter: false }, manager)
            const assignment = await manager.getRepository(HostingTrainerAssignmentEntity).save({ id: apId(), trainerIdentityId: actor.identityId, kind: 'recipient', partnerIdentityId: identity.id, clientPlatformId: null, active: true, revision: 1, provenance: 'onboarded', createdByIdentityId: actor.identityId, userId: null })
            const setupUrl = await issueSetup(manager, actor, authority.trainer.accessVersion, assignment, identity, value.kind, value.workspaceName)
            authority.trainer.revision++; await manager.getRepository(HostingTrainerRoleEntity).save(authority.trainer)
            await history(manager, actor, actor.identityId, authority.trainer.revision, value.requestKey, requestHash, 'onboard', { assignmentId: assignment.id, kind: value.kind, identityId: identity.id })
            return { ...await portfolioView(manager, actor), setupUrl, replayed: false }
        } })
    }
    async function setupChange({ actor, input, revoke = false }: { actor: HostingActor, input: z.infer<typeof TrainerSetupChange>, revoke?: boolean }) {
        const value = TrainerSetupChange.parse(input), requestHash = hash({ action: revoke ? 'revoke_setup' : 'replace_setup', value })
        return tx.run({ dataSource, fn: async manager => {
            const peek = await manager.getRepository(HostingTrainerAssignmentEntity).findOneBy({ id: value.assignmentId, trainerIdentityId: actor.identityId, kind: 'recipient', provenance: 'onboarded' })
            if (!peek?.partnerIdentityId) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
            const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: peek.partnerIdentityId }, lock: { mode: 'pessimistic_write' } })
            const authority = await assertPlatformTrainer({ manager, actor }), current = await trainerFence(manager, actor.identityId)
            const previous = await manager.getRepository(HostingTrainerCommandEntity).findOneBy({ actorIdentityId: actor.identityId, requestKey: value.requestKey })
            if (previous) {
                if (previous.requestHash !== requestHash) hostingFail('HOSTING_TRAINER_IDEMPOTENCY_CONFLICT')
                return { ...await portfolioView(manager, actor), setupUrl: null, replayed: true }
            }
            assertCas(current, value)
            const assignment = await manager.getRepository(HostingTrainerAssignmentEntity).findOne({ where: { id: peek.id, active: true }, lock: { mode: 'pessimistic_write' } })
            if (!assignment || !identity || identity.verified || await manager.getRepository(UserEntity).existsBy({ identityId: identity.id })) hostingFail('HOSTING_TRAINER_ONBOARDING_UNAVAILABLE')
            const latest = await manager.getRepository(HostingTrainerSetupEntity).findOne({ where: { assignmentId: assignment.id }, order: { created: 'DESC' } })
            if (!latest) hostingFail('HOSTING_TRAINER_ONBOARDING_UNAVAILABLE')
            assignment.revision++; if (revoke) assignment.active = false
            await manager.getRepository(HostingTrainerAssignmentEntity).save(assignment)
            await manager.getRepository(HostingTrainerSetupEntity).update({ assignmentId: assignment.id, usedAt: IsNull(), revokedAt: IsNull() }, { revokedAt: await tx.now(manager) })
            const setupUrl = revoke ? null : await issueSetup(manager, actor, authority.trainer.accessVersion, assignment, identity, latest.kind, latest.workspaceName)
            authority.trainer.revision++; await manager.getRepository(HostingTrainerRoleEntity).save(authority.trainer)
            await history(manager, actor, actor.identityId, authority.trainer.revision, value.requestKey, requestHash, revoke ? 'revoke_setup' : 'replace_setup', { assignmentId: assignment.id })
            return { ...await portfolioView(manager, actor), setupUrl, replayed: false }
        } })
    }
    async function inspect(token: string) {
        return tx.run({ dataSource, fn: async manager => {
            const value = await usable(manager, token)
            return { email: value.identity.email, workspaceName: value.setup.workspaceName, kind: value.setup.kind, expiresAt: value.setup.expiresAt.toISOString(), admissionSource: 'trainer', emailOwnershipVerified: false }
        } })
    }
    async function redeem(input: z.infer<typeof TrainerRedeem>) {
        const value = TrainerRedeem.parse(input), password = await passwordHasher.hash(value.password)
        return tx.run({ dataSource, fn: async manager => {
            const { identity, setup, assignment } = await usable(manager, value.token)
            const actor = { identityId: setup.trainerIdentityId, platformId: setup.trainerPlatformId, tokenVersion: setup.trainerTokenVersion }
            await manager.getRepository(UserIdentityEntity).update({ id: identity.id }, { ...signupNames.splitFullName({ fullName: value.fullName, email: identity.email }), password, verified: true, tokenVersion: apId() })
            const tenant = await onboarding.provision({ identityId: identity.id, name: setup.workspaceName, requireOwnedHome: true, trainer: { actor, assignmentId: assignment.id }, manager })
            if (setup.kind === 'partner') {
                assignment.kind = 'partner'; assignment.revision++
                await manager.getRepository(HostingTrainerAssignmentEntity).save(assignment)
            }
            else {
                assignment.active = false; assignment.revision++
                await manager.getRepository(HostingTrainerAssignmentEntity).save(assignment)
                const client = await manager.getRepository(HostingTrainerAssignmentEntity).save({ id: apId(), trainerIdentityId: actor.identityId, kind: 'client', partnerIdentityId: null, clientPlatformId: tenant.platformId, active: true, revision: 1, provenance: 'onboarded', createdByIdentityId: actor.identityId, userId: null })
                await materializeClient(manager, client)
            }
            await manager.getRepository(HostingTrainerSetupEntity).update({ id: setup.id }, { usedAt: await tx.now(manager) })
            await tx.event({ manager, platformId: tenant.platformId, event: 'trainer.recipient.admitted', payload: { identityId: identity.id, trainerIdentityId: actor.identityId, kind: setup.kind, admissionSource: 'trainer', emailOwnershipVerified: false } })
            return tenant
        } })
    }
    async function enterClient({ actor, platformId }: { actor: HostingActor, platformId: string }) {
        return tx.run({ dataSource, fn: async manager => {
            await assertTrainerClient({ manager, actor, platformId })
            const user = await manager.getRepository(UserEntity).findOneBy({ identityId: actor.identityId, platformId, status: UserStatus.ACTIVE })
            if (!user || isOperationalUser(user) && user.externalId !== trainerExternalId(actor.identityId)) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
            const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: actor.identityId })
            return { platformId, userId: user.id, projectId: (await manager.getRepository(HostingAccountEntity).findOneByOrFail({ id: platformId })).initialProjectId, created: false, tokenVersion: identity.tokenVersion ?? null }
        } })
    }
    return { adminList, adminCommand, portfolio, learners, onboard, setupChange, inspect, redeem, enterClient }
}

async function issueSetup(manager: EntityManager, actor: HostingActor, accessVersion: number, assignment: TrainerAssignment, identity: { id: string, email: string, tokenVersion?: string | null }, kind: 'partner' | 'client', workspaceName: string) {
    const token = randomBytes(32).toString('base64url'), now = await tx.now(manager)
    await manager.getRepository(HostingTrainerSetupEntity).insert({ id: apId(), identityId: identity.id, identityEmail: identity.email, identityTokenVersion: identity.tokenVersion ?? null, trainerIdentityId: actor.identityId, trainerPlatformId: actor.platformId, trainerTokenVersion: actor.tokenVersion ?? null, trainerAccessVersion: accessVersion, assignmentId: assignment.id, assignmentRevision: assignment.revision, kind, workspaceName, tokenDigest: hash(token), expiresAt: new Date(now.getTime() + 86400000), usedAt: null, revokedAt: null })
    const url = new URL('/trainer-setup', system.getOrThrow(AppSystemProp.FRONTEND_URL)); url.hash = `token=${token}`; return url.href
}
async function usable(manager: EntityManager, token: string) {
    TrainerSecret.parse(token)
    const peek = await manager.getRepository(HostingTrainerSetupEntity).findOneBy({ tokenDigest: hash(token) })
    if (!peek) hostingFail('HOSTING_TRAINER_SETUP_UNAVAILABLE')
    const identity = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: peek.identityId }, lock: { mode: 'pessimistic_write' } })
    if (!identity || identity.verified || identity.email !== peek.identityEmail || (identity.tokenVersion ?? null) !== peek.identityTokenVersion || await manager.getRepository(UserEntity).existsBy({ identityId: identity.id }) || hostingOperatorIdentityIds().includes(identity.id) || await manager.getRepository(HostingAccessRoleEntity).existsBy({ id: identity.id })) hostingFail('HOSTING_TRAINER_SETUP_UNAVAILABLE')
    const scope = await assertTrainerProvisioning({ manager, actor: { identityId: peek.trainerIdentityId, platformId: peek.trainerPlatformId, tokenVersion: peek.trainerTokenVersion }, identityId: identity.id, assignmentId: peek.assignmentId })
    const setup = await manager.getRepository(HostingTrainerSetupEntity).findOne({ where: { id: peek.id }, lock: { mode: 'pessimistic_write' } })
    if (!setup || setup.usedAt || setup.revokedAt || setup.expiresAt <= await tx.now(manager) || scope.trainer.accessVersion !== setup.trainerAccessVersion || scope.assignment.revision !== setup.assignmentRevision) hostingFail('HOSTING_TRAINER_SETUP_UNAVAILABLE')
    return { identity, setup, assignment: scope.assignment }
}
async function materializeClient(manager: EntityManager, assignment: TrainerAssignment) {
    if (!assignment.clientPlatformId) hostingFail('HOSTING_TRAINER_SCOPE_REQUIRED')
    await tx.account({ manager, platformId: assignment.clientPlatformId })
    const existing = await manager.getRepository(UserEntity).findOneBy({ identityId: assignment.trainerIdentityId, platformId: assignment.clientPlatformId })
    if (existing && existing.externalId !== trainerExternalId(assignment.trainerIdentityId)) {
        if (isOperationalUser(existing) || existing.status !== UserStatus.ACTIVE) hostingFail('HOSTING_TRAINER_EXISTING_MEMBERSHIP_REQUIRES_REVIEW')
        // An independently granted ordinary membership remains exactly as it was.
        return
    }
    const user = await manager.getRepository(UserEntity).save({ id: existing?.id ?? apId(), identityId: assignment.trainerIdentityId, platformId: assignment.clientPlatformId, platformRole: PlatformRole.OPERATOR, status: UserStatus.ACTIVE, externalId: trainerExternalId(assignment.trainerIdentityId) })
    assignment.userId = user.id
    await manager.getRepository(HostingTrainerAssignmentEntity).save(assignment)
}
async function deactivateAssignment(manager: EntityManager, assignment: TrainerAssignment) {
    assignment.active = false; assignment.revision++
    await manager.getRepository(HostingTrainerAssignmentEntity).save(assignment)
    if (assignment.userId) await manager.getRepository(UserEntity).update({ id: assignment.userId, identityId: assignment.trainerIdentityId, externalId: trainerExternalId(assignment.trainerIdentityId) }, { status: UserStatus.INACTIVE })
    await manager.getRepository(HostingTrainerSetupEntity).update({ assignmentId: assignment.id, usedAt: IsNull(), revokedAt: IsNull() }, { revokedAt: await tx.now(manager) })
}
async function revokeTrainerSessions(manager: EntityManager, identityId: string) {
    await manager.getRepository(UserIdentityEntity).update({ id: identityId }, { tokenVersion: apId() })
    const users = await manager.getRepository(UserEntity).findBy({ identityId })
    for (const user of users) await manager.getRepository(McpOAuthTokenEntity).update({ userId: user.id }, { revoked: true })
}
async function trainerFence(manager: EntityManager, identityId: string) {
    const role = await manager.getRepository(HostingTrainerRoleEntity).findOneBy({ id: identityId })
    const assignments = await manager.getRepository(HostingTrainerAssignmentEntity).find({ where: { trainerIdentityId: identityId }, order: { id: 'ASC' } })
    return { revision: role?.revision ?? 0, stateHash: hash({ active: role?.active ?? false, revision: role?.revision ?? 0, accessVersion: role?.accessVersion ?? 0, assignments: assignments.map(a => [a.id, a.kind, a.partnerIdentityId, a.clientPlatformId, a.active, a.revision, a.userId]) }) }
}
async function adminView(manager: EntityManager, identityId: string) {
    const identity = await manager.getRepository(UserIdentityEntity).findOneByOrFail({ id: identityId }), role = await manager.getRepository(HostingTrainerRoleEntity).findOneBy({ id: identityId })
    const rows = await manager.getRepository(HostingTrainerAssignmentEntity).find({ where: { trainerIdentityId: identityId }, order: { created: 'ASC' } })
    const assignments = []
    for (const row of rows) {
        const target = row.kind === 'client' ? await manager.getRepository(PlatformEntity).findOneBy({ id: row.clientPlatformId! }) : await manager.getRepository(UserIdentityEntity).findOneBy({ id: row.partnerIdentityId! })
        assignments.push({ id: row.id, kind: row.kind, targetId: row.clientPlatformId ?? row.partnerIdentityId, name: target && 'name' in target ? target.name : target && 'email' in target ? target.email : 'Unavailable', active: row.active, revision: row.revision })
    }
    return { identityId, email: identity.email, name: [identity.firstName, identity.lastName].filter(Boolean).join(' '), verified: identity.verified, active: role?.active ?? false, ...(await trainerFence(manager, identityId)), assignments }
}
async function portfolioView(manager: EntityManager, actor: HostingActor) {
    const authority = await assertPlatformTrainer({ manager, actor })
    const pending = await manager.getRepository(HostingTrainerAssignmentEntity).findBy({ trainerIdentityId: actor.identityId, kind: 'recipient', active: true })
    const recipients = []
    for (const row of pending) {
        const setup = await manager.getRepository(HostingTrainerSetupEntity).findOne({ where: { assignmentId: row.id, usedAt: IsNull() }, order: { created: 'DESC' } })
        if (setup) recipients.push({ assignmentId: row.id, email: setup.identityEmail, kind: setup.kind, expiresAt: setup.expiresAt.toISOString() })
    }
    return { platformId: actor.platformId, userId: authority.user.id, ...(await trainerFence(manager, actor.identityId)), partners: await listTrainerLearners({ manager, actor, audience: 'partner' }), clients: await listTrainerClients({ manager, actor }), pending: recipients }
}
async function history(manager: EntityManager, actor: HostingActor, trainerIdentityId: string, revision: number, requestKey: string, requestHash: string, action: string, details: Record<string, unknown>) {
    const commands = manager.getRepository(HostingTrainerCommandEntity)
    await commands.save(commands.create({ id: apId(), trainerIdentityId, actorIdentityId: actor.identityId, revision, requestKey, requestHash, action, details }))
    await tx.event({ manager, platformId: actor.platformId, event: `trainer.${action}`, payload: { actorIdentityId: actor.identityId, trainerIdentityId, revision, ...details } })
}
function assertCas(current: { revision: number, stateHash: string }, value: { expectedRevision: number, expectedState: string }) {
    if (current.revision !== value.expectedRevision || current.stateHash !== value.expectedState) hostingFail('HOSTING_TRAINER_REVISION_CONFLICT')
    if (current.revision >= 10000) hostingFail('HOSTING_TRAINER_HISTORY_LIMIT')
}
function hash(value: unknown) {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex') 
}
