import { describe, expect, it } from 'vitest'
import { hostingCatalog } from '../../src/lib/management/hosting/hosting-catalog'

describe('hosted plan catalog', () => {
    it('bounds the no-card trial in time, executions and provider expense', () => {
        const trial = hostingCatalog.getPlan({ planId: 'trial' })
        expect(hostingCatalog.trialDays).toBe(14)
        expect(trial.executions).toBe(1_000)
        expect(trial.concurrency).toBe(1)
        expect(trial.aiCredits * 1_000_000 / hostingCatalog.microcreditsPerMicroUsd).toBe(hostingCatalog.trialOperatorCostLimitMicroUsd)
        expect(hostingCatalog.dailyTrialOperatorCostLimitMicroUsd).toBe(10_000_000)
    })

    it.each(['trial', 'starter', 'team'] as const)('includes BYOK in %s', (planId) => {
        expect(hostingCatalog.getPlan({ planId }).byokEnabled).toBe(true)
    })

    it('does not permit changing the catalog or a shared plan object', () => {
        expect(Object.isFrozen(hostingCatalog)).toBe(true)
        expect(Object.isFrozen(hostingCatalog.getPlan({ planId: 'trial' }))).toBe(true)
    })
})
