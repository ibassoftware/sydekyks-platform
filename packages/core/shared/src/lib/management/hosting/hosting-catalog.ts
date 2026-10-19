function getPlan({ planId }: { planId: HostedPlanId }): HostedPlan {
    return PLANS[planId]
}

const PLANS = Object.freeze({
    trial: Object.freeze({ users: 1, projects: 1, executions: 1_000, concurrency: 1, aiCredits: 1_000, byokEnabled: true }),
    assessment: Object.freeze({ users: 1, projects: 1, executions: 100, concurrency: 1, aiCredits: 1_000, byokEnabled: true }),
    training: Object.freeze({ users: 1, projects: 1, executions: 1_000, concurrency: 1, aiCredits: 5_000, byokEnabled: true }),
    starter: Object.freeze({ users: 3, projects: 3, executions: 10_000, concurrency: 2, aiCredits: 5_000, byokEnabled: true }),
    team: Object.freeze({ users: 10, projects: 10, executions: 50_000, concurrency: 5, aiCredits: 20_000, byokEnabled: true }),
})

export const hostingCatalog = Object.freeze({
    version: '2026-10-15.v1',
    trialDays: 14,
    trainingPeriodDays: 30,
    trainingPeriods: Object.freeze({ core: 2, launch: 3 }),
    microcreditsPerMicroUsd: 1_000,
    trialOperatorCostLimitMicroUsd: 1_000_000,
    dailyTrialOperatorCostLimitMicroUsd: 10_000_000,
    getPlan,
})

export type HostedPlanId = keyof typeof PLANS
export type HostedPlan = Readonly<{
    users: number
    projects: number
    executions: number
    concurrency: number
    aiCredits: number
    byokEnabled: boolean
}>
