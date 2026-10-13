import { apId, tryCatch } from '@activepieces/core-utils'
import { ApEdition, ChatPersonalization, ChatPersonalizationScope, ChatPersonalizationStatus, LATEST_JOB_DATA_SCHEMA_VERSION, PersonalizationPrefill, PersonalizationProfile, PersonalizationScope, PersonalizationUseCase, SavePersonalizationResultRequest, WorkerJobType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { IsNull } from 'typeorm'
import { z } from 'zod'
import { aiProviderService } from '../../../ai/ai-provider-service'
import { distributedStore } from '../../../database/redis-connections'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { hasCreditsLeft } from '../../../platform/billing-provider'
import { jobQueue, JobType } from '../../../workers/job-queue/job-queue'
import { sydCopilotContext } from '../copilot-context'
import { IN_FLIGHT_STATUSES, sydPersonalizationStore, ValidatedResult } from './personalization-store'

function apolloApiKey(): string | null {
    return system.getEdition() === ApEdition.CLOUD ? system.get(AppSystemProp.APOLLO_API_KEY) || null : null
}
function prefillKey({ platformId, userId }: ActorScope): string {
    return `syd:personalization:prefill:v1:${platformId}:${userId}`
}
function prefillLookupKey({ platformId, userId }: ActorScope): string {
    return `syd:personalization:lookup:v1:${platformId}:${userId}`
}

async function readPrefill({ platformId, userId, log }: ActorScope & { log: FastifyBaseLogger }): Promise<PersonalizationPrefill | null> {
    const result = await tryCatch(() => distributedStore.get<unknown>(prefillKey({ platformId, userId })))
    if (result.error) {
        log.warn({ error: result.error }, 'Syd prefill lookup failed'); return null
    }
    const validated = PersonalizationPrefill.safeParse(result.data)
    return validated.success ? validated.data : null
}

async function startPrefillLookup({ platformId, userId, log }: ActorScope & { log: FastifyBaseLogger }): Promise<void> {
    if (!apolloApiKey()) return
    const outcome = await tryCatch(async () => {
        if (!await distributedStore.putIfAbsent(prefillLookupKey({ platformId, userId }), true, PREFILL_TTL_SECONDS)) return
        await enqueueResearchJob({ platformId, userId, scope: 'company', website: null, companyText: null, role: null, researchToken: null, prefillOnly: true, log })
    })
    if (outcome.error) log.warn({ error: outcome.error }, 'Syd prefill research could not start')
}

async function guardsAllowResearch({ platformId, log }: { platformId: string, log: FastifyBaseLogger }): Promise<boolean> {
    const provider = await tryCatch(() => aiProviderService(log).getChatProvider({ platformId, scope: { type: 'platform' } }))
    if (!provider.data || provider.error || !await hasCreditsLeft({ platformId, log })) return false
    return (await sydCopilotContext.incrementAndCheckLimit({ key: `syd:personalization:runs:v1:${platformId}`, limit: 5, ttlSeconds: 86_400 })).allowed
}

async function enqueueResearchJob({ platformId, userId, scope, website, companyText, role, researchToken, prefillOnly, log }: ResearchJobParams): Promise<void> {
    await jobQueue(log).add({ id: apId(), type: JobType.ONE_TIME, data: {
        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION, jobType: WorkerJobType.EXECUTE_PERSONALIZATION_RESEARCH,
        platformId, userId, projectId: null, scope, website, companyText, role, researchToken, prefillOnly: prefillOnly ?? false,
    } })
}

async function claimForResearch({ platformId, userId, scope, researchToken }: ActorScope & { scope: PersonalizationScope, researchToken: string | null }): Promise<boolean> {
    const result = await sydPersonalizationStore.personalizationRepo().createQueryBuilder().update().set({ status: ChatPersonalizationStatus.RESEARCHING })
        .where({ platformId, userId: scope === 'user' ? userId : IsNull(), status: ChatPersonalizationStatus.PENDING, ...(researchToken ? { researchToken } : {}) }).returning('id').execute()
    return Array.isArray(result.raw) && result.raw.length > 0
}

async function takeOverStaleRow({ observed, researchToken }: { observed: ChatPersonalization, researchToken: string }): Promise<ChatPersonalization | null> {
    const result = await sydPersonalizationStore.personalizationRepo().createQueryBuilder().update().set({ status: ChatPersonalizationStatus.PENDING, researchToken })
        .where({ id: observed.id, platformId: observed.platformId, updated: observed.updated })
        .andWhere('status IN (:...states)', { states: IN_FLIGHT_STATUSES }).andWhere('updated < :threshold', { threshold: new Date(Date.now() - RESEARCH_STALENESS_TIMEOUT_MS) }).returning('id').execute()
    return Array.isArray(result.raw) && result.raw.length ? sydPersonalizationStore.findRow({ platformId: observed.platformId, userId: observed.userId ?? null }) : null
}

async function recoverIfStale({ row, platformId, userId, scope, log }: ActorScope & { row: ChatPersonalization | null, scope: ChatPersonalizationScope, log: FastifyBaseLogger }): Promise<ChatPersonalization | null> {
    if (!row || !IN_FLIGHT_STATUSES.includes(row.status) || Date.now() - Date.parse(row.updated) <= RESEARCH_STALENESS_TIMEOUT_MS) return row
    const outcome = await tryCatch(async () => {
        const researchToken = apId()
        const claimed = await takeOverStaleRow({ observed: row, researchToken })
        if (!claimed) return
        if (!await guardsAllowResearch({ platformId, log })) {
            await sydPersonalizationStore.personalizationRepo().update({ id: claimed.id, platformId, researchToken }, { status: ChatPersonalizationStatus.FAILED })
            return
        }
        await enqueueResearchJob({ platformId, userId, scope, website: scope === ChatPersonalizationScope.COMPANY ? claimed.domain ?? null : null, companyText: scope === ChatPersonalizationScope.COMPANY ? claimed.companyText ?? null : null, role: claimed.role ?? null, researchToken, log })
    })
    if (outcome.error) {
        log.warn({ error: outcome.error, platform: { id: platformId } }, 'Syd stale research recovery failed'); return row
    }
    return sydPersonalizationStore.findRow({ platformId, userId: scope === ChatPersonalizationScope.USER ? userId : null })
}

function validateResult({ input }: { input: SavePersonalizationResultRequest, log: FastifyBaseLogger }): ValidatedResult {
    const profile = PersonalizationProfile.safeParse(input.profile)
    const useCases = UseCasesSchema.safeParse(input.useCases)
    return input.status === 'READY' && profile.success && useCases.success && useCases.data.length
        ? { status: ChatPersonalizationStatus.READY, profile: profile.data, useCases: useCases.data }
        : { status: ChatPersonalizationStatus.FAILED, profile: null, useCases: null }
}

export const sydPersonalizationResearch = { apolloApiKey, prefillKey, prefillLookupKey, readPrefill, startPrefillLookup, guardsAllowResearch, enqueueResearchJob, claimForResearch, takeOverStaleRow, recoverIfStale, validateResult }
export const PREFILL_TTL_SECONDS = 604_800
export const RESEARCH_STALENESS_TIMEOUT_MS = 120_000

type ActorScope = { platformId: string, userId: string }
type ResearchJobParams = ActorScope & { scope: PersonalizationScope, website: string | null, companyText: string | null, role: string | null, researchToken: string | null, prefillOnly?: boolean, log: FastifyBaseLogger }

export const UseCasesSchema = z.array(PersonalizationUseCase)
