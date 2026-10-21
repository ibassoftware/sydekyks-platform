import { EntityManager } from 'typeorm'
import { LmsEnrollment } from '../lms/lms-entities'
import { HostingAccountEntity } from './hosting-entities'
import { HostingManualAccountEntity, HostingManualTerm, HostingManualTermEntity, ManualPlan } from './hosting-manual-accounts-entities'
import { fundedClosingPeriod, hostingMonthAnniversary } from './hosting-training-periods'
import { hostingFail } from './hosting-transactions'

export const MAX_MANUAL_TERM_MONTHS = 36
export function manualTermPeriods(term: Pick<HostingManualTerm, 'startsAt' | 'expiresAt'>): { from: Date, until: Date }[] {
    if (!Number.isFinite(term.startsAt.getTime()) || !Number.isFinite(term.expiresAt.getTime()) || term.expiresAt <= term.startsAt || term.expiresAt > hostingMonthAnniversary(term.startsAt, MAX_MANUAL_TERM_MONTHS)) hostingFail('HOSTING_MANUAL_TERM_DATE_INVALID')
    const periods = []
    for (let month = 0; month < MAX_MANUAL_TERM_MONTHS; month++) {
        const from = hostingMonthAnniversary(term.startsAt, month)
        if (from >= term.expiresAt) break
        const next = hostingMonthAnniversary(term.startsAt, month + 1)
        periods.push({ from, until: next < term.expiresAt ? next : term.expiresAt })
    }
    return periods
}
// An explicit earlier due date closes its current funded month. At an exact
// anniversary the preceding month closes; a future monthly grant never refills grace.
export function manualClosingPeriod(term: Pick<HostingManualTerm, 'startsAt' | 'expiresAt'>, due?: Date): number {
    return fundedClosingPeriod(manualTermPeriods(term), due)
}
export function manualTermSource(term: Pick<HostingManualTerm, 'id' | 'planId'>, period: number): string {
    return `manual:${term.planId}:${term.id}:${period}`
}
export async function currentManualTerm(manager: EntityManager, account: { id: string, ownerIdentityId: string, planId: string, validUntil: Date }): Promise<HostingManualTerm | null> {
    const binding = await manager.getRepository(HostingManualAccountEntity).findOneBy({ id: account.id, identityId: account.ownerIdentityId })
    if (!binding) return null
    const term = await manager.getRepository(HostingManualTermEntity).findOneBy({ id: binding.termId, platformId: account.id, identityId: account.ownerIdentityId, revision: binding.revision })
    return term && term.planId === account.planId && term.expiresAt.getTime() === account.validUntil.getTime() ? term : null
}
export async function manualGrantPlan(manager: EntityManager, account: { id: string, ownerIdentityId: string }, grant: { sourceKey: string, validFrom: Date, validUntil: Date }): Promise<ManualPlan | null> {
    const parsed = /^manual:(training|starter|team|scale):([a-zA-Z0-9_-]{21}):(\d{1,2})$/.exec(grant.sourceKey)
    if (!parsed) return null
    const term = await manager.getRepository(HostingManualTermEntity).findOneBy({ id: parsed[2], platformId: account.id, identityId: account.ownerIdentityId, planId: parsed[1] as ManualPlan })
    const period = term ? manualTermPeriods(term)[Number(parsed[3])] : null
    if (!term || !period || period.from.getTime() !== grant.validFrom.getTime() || period.until.getTime() !== grant.validUntil.getTime()) hostingFail('HOSTING_MANUAL_FUNDING_SOURCE_INVALID')
    return term.planId
}

export async function manualEnrollmentDelivery(manager: EntityManager, enrollment: LmsEnrollment) {
    if (enrollment.accessType !== 'partner_training' || !enrollment.workspacePlatformId) return null
    const binding = await manager.getRepository(HostingManualAccountEntity).findOneBy({ id: enrollment.workspacePlatformId, identityId: enrollment.identityId, enrollmentId: enrollment.id, kind: 'partner' })
    if (!binding) return null
    const account = await manager.getRepository(HostingAccountEntity).findOneBy({ id: binding.id, ownerIdentityId: enrollment.identityId })
    const term = account ? await currentManualTerm(manager, account) : null
    if (!term || term.planId !== 'training') return null
    return { activated: true as const, startsAt: term.startsAt.toISOString(), endsAt: term.expiresAt.toISOString(), revoked: enrollment.status !== 'active', funding: 'manual' as const }
}
