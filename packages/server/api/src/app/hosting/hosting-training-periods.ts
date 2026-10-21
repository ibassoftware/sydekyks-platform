import { hostingCatalog } from '@activepieces/shared'

// Anchor every month to the original UTC anniversary. Clamping February must
// not make a January 31 purchase renew on March 28 in the following period.
export function hostingMonthAnniversary(startsAt: Date, months: number): Date {
    const target = new Date(startsAt)
    target.setUTCDate(1)
    target.setUTCMonth(startsAt.getUTCMonth() + months)
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
    target.setUTCDate(Math.min(startsAt.getUTCDate(), lastDay))
    return target
}

export function newPartnerTrainingPeriods(startsAt: Date): { from: Date, until: Date }[] {
    return Array.from({ length: hostingCatalog.partnerHostingMonths }, (_, month) => ({
        from: hostingMonthAnniversary(startsAt, month), until: hostingMonthAnniversary(startsAt, month + 1),
    }))
}

// Existing records have immutable start/end timestamps. Recognize the exact old
// 60/90-day schedules independently of the current catalogue; never extend them
// or rewrite their grants when reading or applying a renewal override.
export function fundedTrainingPeriods(training: { tier: 'core' | 'launch', startsAt: Date, endsAt: Date }): { from: Date, until: Date }[] | null {
    const legacyCount = training.tier === 'core' ? 2 : 3
    const periodMs = 30 * 86_400_000
    if (training.endsAt.getTime() === training.startsAt.getTime() + legacyCount * periodMs) {
        return Array.from({ length: legacyCount }, (_, period) => ({ from: new Date(training.startsAt.getTime() + period * periodMs), until: new Date(training.startsAt.getTime() + (period + 1) * periodMs) }))
    }
    const periods = newPartnerTrainingPeriods(training.startsAt)
    return periods.at(-1)?.until.getTime() === training.endsAt.getTime() ? periods : null
}

// An earlier renewal due date closes the funded period containing that boundary.
// Exact anniversaries close the preceding period; later prepaid periods cannot refill grace.
export function fundedClosingPeriod(periods: { from: Date, until: Date }[], due?: Date): number {
    if (!due) return periods.length - 1
    const closing = periods.findIndex(period => period.until >= due)
    return closing < 0 ? periods.length - 1 : closing
}
