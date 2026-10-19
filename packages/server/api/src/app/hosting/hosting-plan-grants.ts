import { HostedPlanId } from '@activepieces/shared'

// A plan cannot accidentally spend a different entitlement's unused allowance.
export function hostingGrantMatchesPlan(grant: { sourceKey: string }, planId: HostedPlanId): boolean {
    const prefix = planId === 'trial' ? 'trial:' : planId === 'training' ? 'training:' : planId === 'assessment' ? 'assessment:' : 'stripe:'
    return grant.sourceKey.startsWith(prefix)
}
