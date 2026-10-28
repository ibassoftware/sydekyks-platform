import { describe, expect, it } from 'vitest'
import { hostingCatalog } from '../src/lib/management/hosting/hosting-catalog'
describe('approved Credits catalogue and existing agreements', () => {
    it('uses approved ledger amounts for newly funded terms', () => {
        expect(['starter', 'team', 'scale', 'training'].map(planId => hostingCatalog.getPlan({ planId: planId as 'starter' }).executions)).toEqual([30000, 120000, 400000, 30000])
        expect(hostingCatalog.getPlan({ planId: 'training' }).users).toBe(1)
        expect(hostingCatalog.aiMicroUsdPerCredit).toBe(1500)
    })
    it('keeps old catalogue agreements exact until an explicit funded revision', () => {
        for (const catalogVersion of ['2026-10-15.v1', '2026-10-20.v2']) {
            expect(['starter', 'team', 'scale', 'training'].map(planId => hostingCatalog.getPlan({ planId: planId as 'starter', catalogVersion }).executions)).toEqual([10000, 100000, 500000, 10000])
        }
    })
})
