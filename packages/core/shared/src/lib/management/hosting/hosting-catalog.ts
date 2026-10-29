function getPlan({ planId, catalogVersion }: { planId: HostedPlanId, catalogVersion?: string }): HostedPlan {
    const plan = PLANS[planId]
    const legacy = { training: 10_000, starter: 10_000, team: 100_000, scale: 500_000 }
    return catalogVersion && catalogVersion !== '2026-10-28.display-credits-v1' && planId in legacy
        ? { ...plan, executions: legacy[planId as keyof typeof legacy] } : plan
}

// aiCredits is retained for historical grant compatibility only. New managed AI
// calls spend execution Credits at the snapshotted supplier-cost conversion.
const PLANS = Object.freeze({
    trial: Object.freeze({ users: 1, projects: 1, executions: 1_000, concurrency: 1, aiCredits: 1_000, byokEnabled: true }),
    assessment: Object.freeze({ users: 1, projects: 1, executions: 100, concurrency: 1, aiCredits: 1_000, byokEnabled: true }),
    // Every hosted client shares one Command Center across its advertised seats.
    training: Object.freeze({ users: 1, projects: 1, executions: 30_000, concurrency: 2, aiCredits: 5_000, byokEnabled: true }),
    starter: Object.freeze({ users: 10, projects: 1, executions: 30_000, concurrency: 2, aiCredits: 5_000, byokEnabled: true }),
    // Keep the persisted team identifier; its customer-facing name is Growth.
    team: Object.freeze({ users: 30, projects: 1, executions: 120_000, concurrency: 5, aiCredits: 20_000, byokEnabled: true }),
    scale: Object.freeze({ users: 100, projects: 1, executions: 400_000, concurrency: 10, aiCredits: 0, byokEnabled: true }),
})

export const hostingCatalog = Object.freeze({
    version: '2026-10-28.display-credits-v1',
    supportedVersions: Object.freeze(['2026-10-15.v1', '2026-10-20.v2', '2026-10-28.display-credits-v1']),
    trialDays: 14,
    // Historical windows must never be recalculated from the new offer.
    trainingPeriodDays: 30,
    trainingPeriods: Object.freeze({ core: 2, launch: 3 }),
    partnerHostingMonths: 12,
    partnerPackages: Object.freeze({
        core: Object.freeze({ name: 'Partner Core', amountMinor: 100_000, currency: 'usd', coachingHours: 2, proposalReviews: 0, assessmentAttempts: 2 }),
        launch: Object.freeze({ name: 'Partner Guided', amountMinor: 120_000, currency: 'usd', coachingHours: 4, proposalReviews: 1, assessmentAttempts: 2 }),
    }),
    paidPlans: Object.freeze({
        starter: Object.freeze({ name: 'Starter', amountMinor: 9_900, currency: 'usd', salesAssisted: false }),
        team: Object.freeze({ name: 'Growth', amountMinor: 39_900, currency: 'usd', salesAssisted: false }),
        scale: Object.freeze({ name: 'Scale', amountMinor: 129_900, currency: 'usd', salesAssisted: true }),
    }),
    // Numeric API quantities and all persisted accounting stay in ledger units.
    ledgerUnitsPerDisplayedCredit: 100,
    supplierMicroUsdPerDisplayedCredit: 150_000,
    aiMicroUsdPerCredit: 1_500,
    maxCreditsPerRun: 1_000,
    // Legacy accounting conversion; do not use for new managed AI charges.
    microcreditsPerMicroUsd: 1_000,
    trialOperatorCostLimitMicroUsd: 1_000_000,
    dailyTrialOperatorCostLimitMicroUsd: 10_000_000,
    getPlan,
})

export type HostedPlanId = keyof typeof PLANS
export type HostedPaidPlanId = keyof typeof hostingCatalog.paidPlans
export type HostedPlan = Readonly<{
    users: number
    projects: number
    executions: number
    concurrency: number
    /** Historical compatibility only, not a spendable allowance. */
    aiCredits: number
    byokEnabled: boolean
}>
