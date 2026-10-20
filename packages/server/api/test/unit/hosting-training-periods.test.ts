import { describe, expect, it } from 'vitest'
import { fundedTrainingPeriods, hostingMonthAnniversary, newPartnerTrainingPeriods } from '../../src/app/hosting/hosting-training-periods'

describe('immutable Partner hosting periods', () => {
    it('anchors month-end renewals to the purchase anniversary without February drift', () => {
        const start = new Date('2027-01-31T23:45:12.123Z')
        const periods = newPartnerTrainingPeriods(start)
        expect(periods).toHaveLength(12)
        expect(periods[0].until.toISOString()).toBe('2027-02-28T23:45:12.123Z')
        expect(periods[1].until.toISOString()).toBe('2027-03-31T23:45:12.123Z')
        expect(periods[11].until.toISOString()).toBe('2028-01-31T23:45:12.123Z')
        for (let i = 1; i < periods.length; i++) expect(periods[i].from).toEqual(periods[i - 1].until)
    })
    it('clamps leap-day annual access and preserves the original day for later anniversaries', () => {
        const start = new Date('2028-02-29T12:00:00.000Z')
        expect(hostingMonthAnniversary(start, 1).toISOString()).toBe('2028-03-29T12:00:00.000Z')
        expect(hostingMonthAnniversary(start, 12).toISOString()).toBe('2029-02-28T12:00:00.000Z')
    })
    it.each([['core', 2], ['launch', 3]] as const)('preserves legacy %s fixed periods independently of the new offer', (tier, count) => {
        const startsAt = new Date('2026-10-18T14:37:29.000Z')
        const endsAt = new Date(startsAt.getTime() + count * 30 * 86400000)
        const periods = fundedTrainingPeriods({ tier, startsAt, endsAt })!
        expect(periods).toHaveLength(count)
        expect(periods.at(-1)!.until).toEqual(endsAt)
        expect(periods.every(period => period.until.getTime() - period.from.getTime() === 30 * 86400000)).toBe(true)
    })
    it.each(['core', 'launch'] as const)('recognizes a new %s twelve-month record from its immutable funding window', tier => {
        const startsAt = new Date('2026-10-20T12:30:00.000Z'), endsAt = hostingMonthAnniversary(startsAt, 12)
        expect(fundedTrainingPeriods({ tier, startsAt, endsAt })).toEqual(newPartnerTrainingPeriods(startsAt))
        expect(endsAt.getTime() - startsAt.getTime()).toBe(365 * 86400000)
    })
    it('refuses ambiguous or changed funding windows rather than inventing new Credits', () => {
        const startsAt = new Date('2026-10-20T12:30:00.000Z')
        expect(fundedTrainingPeriods({ tier: 'core', startsAt, endsAt: new Date(startsAt.getTime() + 360 * 86400000) })).toBeNull()
        expect(fundedTrainingPeriods({ tier: 'core', startsAt, endsAt: new Date(hostingMonthAnniversary(startsAt, 12).getTime() + 1) })).toBeNull()
    })
})
