import { apId, sanitizeObjectForPostgresql, tryCatch } from '@activepieces/core-utils'
import { ChatPersonalization, ChatPersonalizationScope, ChatPersonalizationStatus, ChatPersonalizationView, GetPersonalizationConfigRequest, GetPersonalizationPrefillConfigRequest, PersonalizationConfigResponse, PersonalizationPrefillConfigResponse, SavePersonalizationPrefillRequest, SavePersonalizationResultRequest, SendPersonalizationProgressRequest } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { IsNull, Not } from 'typeorm'
import { aiToolConfigService } from '../../../ai/ai-tool-config-service'
import { distributedStore } from '../../../database/redis-connections'
import { platformService } from '../../../platform/platform.service'
import { userService } from '../../../user/user-service'
import { ActorScope, sydCopilotContext } from '../copilot-context'
import { PREFILL_TTL_SECONDS, RESEARCH_STALENESS_TIMEOUT_MS, sydPersonalizationResearch } from './personalization-research'
import { IN_FLIGHT_STATUSES, sydPersonalizationStore, UpsertParams } from './personalization-store'
import { PersonalizationIdentity, sydPersonalizationView } from './personalization-view'
import { sydProfileNormalization } from './profile-normalization'

export const sydPersonalizationService = (log: FastifyBaseLogger) => ({
    async upsert({ platformId, userId, website, role: submittedRole, personalize }: UpsertParams): Promise<ChatPersonalizationView> {
        const actor = { platformId, userId }
        const existing = await sydPersonalizationStore.findRow({ platformId, userId: null })
        const input = website?.trim() || null
        const established = Boolean(existing?.domain || existing?.companyText)
        const maySubmit = Boolean(input) && (!established || await sydPersonalizationStore.callerMayEditCompany({ ...actor, log }))
        const role = submittedRole === undefined ? null : sydProfileNormalization.normalizeRoleTitle({ input: submittedRole })
        if (personalize && !maySubmit && established && existing) return this.upsertUserScope({ ...actor, companyRow: existing, role })
        const websiteInput = maySubmit && input ? sydProfileNormalization.normalizeWebsite({ input }) : null
        const domain = maySubmit ? websiteInput : existing?.domain ?? null
        const companyText = maySubmit ? websiteInput ? null : input?.slice(0, 255) ?? null : existing?.companyText ?? null
        if (!personalize || (!domain && !companyText)) {
            await sydPersonalizationStore.writeUserRow({ ...actor, patch: { domain: null, companyText: null, role: null, status: ChatPersonalizationStatus.SKIPPED, profile: null, useCases: null } })
            return this.getEffectiveView(actor)
        }
        const changed = domain !== (existing?.domain ?? null) || companyText !== (existing?.companyText ?? null)
        if (existing && !changed) {
            if (existing.status === ChatPersonalizationStatus.SKIPPED && existing.useCases?.length) {
                await sydPersonalizationStore.personalizationRepo().update({ id: existing.id, platformId }, { status: ChatPersonalizationStatus.READY })
                await sydPersonalizationStore.personalizationRepo().update({ platformId, userId, useCases: Not(IsNull()) }, { status: ChatPersonalizationStatus.READY })
                return this.upsertUserScope({ ...actor, companyRow: existing, role })
            }
            if (existing.status === ChatPersonalizationStatus.READY || (IN_FLIGHT_STATUSES.includes(existing.status) && Date.now() - Date.parse(existing.updated) < RESEARCH_STALENESS_TIMEOUT_MS)) return this.upsertUserScope({ ...actor, companyRow: existing, role })
        }
        const permitted = await sydPersonalizationResearch.guardsAllowResearch({ platformId, log })
        const researchToken = permitted ? apId() : null
        const patch = { domain, companyText, status: permitted ? ChatPersonalizationStatus.PENDING : ChatPersonalizationStatus.SKIPPED, researchToken, ...(changed ? { profile: null, useCases: null } : {}) }
        await sydPersonalizationStore.writeCompanyRow({ platformId, existing, patch })
        await sydPersonalizationStore.writeUserRow({ ...actor, patch: { ...patch, role } })
        if (permitted) await sydPersonalizationResearch.enqueueResearchJob({ ...actor, scope: 'company', website: domain, companyText, role, researchToken, log })
        return this.getEffectiveView(actor)
    },

    async upsertUserScope({ platformId, userId, companyRow, role }: ActorScope & { companyRow: ChatPersonalization, role: string | null }): Promise<ChatPersonalizationView> {
        const actor = { platformId, userId }
        const row = await sydPersonalizationStore.findRow(actor)
        const roleChanged = role !== null && role !== row?.role
        const fresh = row !== null && Date.now() - Date.parse(row.updated) < RESEARCH_STALENESS_TIMEOUT_MS
        if (row && ([ChatPersonalizationStatus.READY, ChatPersonalizationStatus.SKIPPED].includes(row.status) || (fresh && !roleChanged))) {
            if (roleChanged) await sydPersonalizationStore.writeUserRow({ ...actor, patch: { role } })
            return this.getEffectiveView(actor)
        }
        const researchToken = apId()
        await sydPersonalizationStore.writeUserRow({ ...actor, patch: { ...(row ? {} : { domain: companyRow.domain, companyText: companyRow.companyText, profile: null, useCases: null }), ...(role !== null ? { role } : {}), status: ChatPersonalizationStatus.PENDING, researchToken } })
        if (await sydPersonalizationResearch.guardsAllowResearch({ platformId, log })) {
            await sydPersonalizationResearch.enqueueResearchJob({ ...actor, scope: 'user', website: null, companyText: null, role, researchToken, log })
        }
        else await sydPersonalizationStore.writeUserRow({ ...actor, patch: { status: ChatPersonalizationStatus.SKIPPED } })
        return this.getEffectiveView(actor)
    },

    async getEffectiveView({ platformId, userId }: ActorScope): Promise<ChatPersonalizationView> {
        const actor = { platformId, userId }
        const found = await Promise.all([sydPersonalizationStore.findRow(actor), sydPersonalizationStore.findRow({ platformId, userId: null })])
        const [user, company] = await Promise.all([
            sydPersonalizationResearch.recoverIfStale({ ...actor, row: found[0], scope: ChatPersonalizationScope.USER, log }),
            sydPersonalizationResearch.recoverIfStale({ ...actor, row: found[1], scope: ChatPersonalizationScope.COMPANY, log }),
        ])
        const personalStatus = user?.status ?? ChatPersonalizationStatus.UNSET
        const winner = user?.status === ChatPersonalizationStatus.READY ? user : company ?? user
        if (winner) return sydPersonalizationView.toView({ row: winner, scope: winner === user ? ChatPersonalizationScope.USER : ChatPersonalizationScope.COMPANY, inputsRow: company ?? winner, role: user?.role ?? null, personalStatus, prefill: null })
        await sydPersonalizationResearch.startPrefillLookup({ ...actor, log })
        return { status: ChatPersonalizationStatus.UNSET, personalStatus, scope: ChatPersonalizationScope.COMPANY, useCases: [], profile: null, companyInput: null, roleInput: null, prefill: await sydPersonalizationResearch.readPrefill({ ...actor, log }) }
    },

    async getConfigForWorker({ platformId, userId, scope, researchToken }: GetPersonalizationConfigRequest): Promise<PersonalizationConfigResponse> {
        if (!await sydPersonalizationResearch.claimForResearch({ platformId, userId, scope, researchToken })) return { claimed: false }
        const [credentials, user, platform, company, personal, tools] = await Promise.all([
            sydCopilotContext.resolveChatProvider({ platformId, scope: { type: 'platform' }, log }),
            userService(log).getMetaInformation({ id: userId }), platformService(log).getOneOrThrow(platformId),
            sydPersonalizationStore.findRow({ platformId, userId: null }), sydPersonalizationStore.findRow({ platformId, userId }),
            tryCatch(() => aiToolConfigService(log).getEnabledTools({ platformId })),
        ])
        const params: Parameters<typeof sydCopilotContext.resolveFastModelId>[0] = { platformId, providerConfig: credentials, surface: 'chat', scope: { type: 'platform' }, log }
        return { claimed: true, credentials, modelId: await sydCopilotContext.resolveModelId({ ...params, selectedModel: null }), fastModelId: await sydCopilotContext.resolveFastModelId(params),
            user: { firstName: user.firstName, lastName: user.lastName, email: user.email }, platformName: platform.name,
            website: company?.domain ?? null, companyText: company?.companyText ?? null, role: personal?.role ?? null,
            companyProfile: company?.status === ChatPersonalizationStatus.READY ? company.profile ?? null : null, webSearch: tools.data?.webSearch ?? null }
    },

    async getPrefillConfigForWorker({ userId }: GetPersonalizationPrefillConfigRequest): Promise<PersonalizationPrefillConfigResponse> {
        return { email: (await userService(log).getMetaInformation({ id: userId })).email, apolloApiKey: sydPersonalizationResearch.apolloApiKey() }
    },

    async saveResult(input: SavePersonalizationResultRequest): Promise<void> {
        const { platformId, userId, scope, researchToken } = input
        const validated = sydPersonalizationResearch.validateResult({ input, log })
        const result = await sydPersonalizationStore.personalizationRepo().createQueryBuilder().update()
            .set(sanitizeObjectForPostgresql(validated)).where({ platformId, userId: scope === 'user' ? userId : IsNull(), ...(researchToken ? { researchToken } : {}) }).returning('id').execute()
        if (!Array.isArray(result.raw) || !result.raw.length) return
        if (scope === 'company' && validated.status === ChatPersonalizationStatus.READY) await sydPersonalizationStore.upsertFoundingUserRow({ platformId, userId, researchToken, validated, log })
        sydPersonalizationView.emitProgress({ userId, event: { platformId, scope: sydPersonalizationView.toScopeEnum(scope), phase: validated.status === ChatPersonalizationStatus.READY ? 'done' : 'failed', message: validated.status === ChatPersonalizationStatus.READY ? 'Your use cases are ready' : 'Could not personalize this time', done: true, result: await this.getEffectiveView({ platformId, userId }) } })
    },

    async sendProgress({ platformId, userId, scope, researchToken, phase, message }: SendPersonalizationProgressRequest): Promise<void> {
        const result = await sydPersonalizationStore.personalizationRepo().createQueryBuilder().update().set({ status: ChatPersonalizationStatus.RESEARCHING })
            .where({ platformId, userId: scope === 'user' ? userId : IsNull(), status: ChatPersonalizationStatus.RESEARCHING, ...(researchToken ? { researchToken } : {}) }).returning('id').execute()
        if (Array.isArray(result.raw) && result.raw.length) sydPersonalizationView.emitProgress({ userId, event: { platformId, scope: sydPersonalizationView.toScopeEnum(scope), phase, message, done: false } })
    },

    async savePrefill({ platformId, userId, role, confidence }: SavePersonalizationPrefillRequest): Promise<void> {
        if (await sydPersonalizationStore.findRow({ platformId, userId: null })) return
        const prefill = { role, confidence }
        await distributedStore.put(sydPersonalizationResearch.prefillKey({ platformId, userId }), prefill, PREFILL_TTL_SECONDS)
        sydPersonalizationView.emitProgress({ userId, event: { platformId, scope: ChatPersonalizationScope.COMPANY, phase: 'prefill', message: 'Looking you up', done: false, prefill } })
    },

    async getIdentityEnrichment(actor: ActorScope): Promise<PersonalizationIdentity | null> {
        const view = await this.getEffectiveView(actor)
        const company = view.status === ChatPersonalizationStatus.READY && view.profile ? { name: view.profile.companyName, description: view.profile.description, industry: view.profile.industry } : null
        const role = view.roleInput ?? null
        return company || role ? { company, role } : null
    },
})
