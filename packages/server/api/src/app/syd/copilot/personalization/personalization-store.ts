import { apId, sanitizeObjectForPostgresql } from '@activepieces/core-utils'
import { ChatPersonalization, ChatPersonalizationStatus, PersonalizationProfile, PersonalizationUseCase, PlatformRole } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { IsNull } from 'typeorm'
import { transaction } from '../../../core/db/transaction'
import { databaseConnection } from '../../../database/database-connection'
import { userService } from '../../../user/user-service'
import { SydPersonalizationEntity } from '../models/personalization.entity'

function personalizationRepo() {
    return databaseConnection().getRepository(SydPersonalizationEntity)
}

async function findRow({ platformId, userId }: PersonalizationIdentifier): Promise<ChatPersonalization | null> {
    return personalizationRepo().findOneBy({ platformId, userId: userId ?? IsNull() })
}

async function writeScopedRow({ platformId, userId, patch }: PersonalizationIdentifier & { patch: PersonalizationPatch }): Promise<void> {
    await transaction(async (manager) => {
        const repo = manager.getRepository(SydPersonalizationEntity)
        await repo.createQueryBuilder().insert().values({ id: apId(), platformId, userId, domain: null, companyText: null, role: null, status: ChatPersonalizationStatus.PENDING, researchToken: null, profile: null, useCases: null }).orIgnore().execute()
        await repo.update({ platformId, userId: userId ?? IsNull() }, sanitizeObjectForPostgresql(patch))
    })
}

async function writeCompanyRow({ platformId, patch }: { platformId: string, existing: ChatPersonalization | null, patch: PersonalizationPatch }): Promise<void> {
    await writeScopedRow({ platformId, userId: null, patch })
}

async function writeUserRow({ platformId, userId, patch }: { platformId: string, userId: string, patch: PersonalizationPatch }): Promise<void> {
    await writeScopedRow({ platformId, userId, patch })
}

async function callerMayEditCompany({ platformId, userId, log }: { platformId: string, userId: string, log: FastifyBaseLogger }): Promise<boolean> {
    const user = await userService(log).getMetaInformation({ id: userId })
    return user.platformId === platformId && user.platformRole === PlatformRole.ADMIN
}

async function upsertFoundingUserRow({ platformId, userId, researchToken, validated }: { platformId: string, userId: string, researchToken: string | null, validated: ValidatedResult, log: FastifyBaseLogger }): Promise<void> {
    if (!researchToken) return
    await transaction(async (manager) => {
        const repo = manager.getRepository(SydPersonalizationEntity)
        const company = await repo.findOne({ where: { platformId, userId: IsNull(), researchToken }, lock: { mode: 'pessimistic_write' } })
        if (!company) return
        const result = sanitizeObjectForPostgresql({ profile: validated.profile, useCases: validated.useCases })
        await repo.createQueryBuilder().insert().values({ id: apId(), platformId, userId, role: null, domain: null, companyText: null, status: ChatPersonalizationStatus.READY, researchToken: null, ...result }).orIgnore().execute()
        const user = await repo.findOne({ where: { platformId, userId }, lock: { mode: 'pessimistic_write' } })
        if (!user || (user.researchToken !== researchToken && (IN_FLIGHT_STATUSES.includes(user.status) || user.useCases !== null))) return
        await repo.update({ platformId, userId }, { status: ChatPersonalizationStatus.READY, ...result })
    })
}

export const sydPersonalizationStore = { personalizationRepo, findRow, writeCompanyRow, writeUserRow, callerMayEditCompany, upsertFoundingUserRow }
export const IN_FLIGHT_STATUSES = [ChatPersonalizationStatus.PENDING, ChatPersonalizationStatus.RESEARCHING]

export type PersonalizationIdentifier = { platformId: string, userId: string | null }
export type PersonalizationPatch = Partial<Pick<ChatPersonalization, 'domain' | 'companyText' | 'role' | 'status' | 'researchToken' | 'profile' | 'useCases'>>
export type UpsertParams = { platformId: string, userId: string, website?: string, role?: string, personalize: boolean }
export type ValidatedResult = { status: ChatPersonalizationStatus, profile: PersonalizationProfile | null, useCases: PersonalizationUseCase[] | null }
