import { HostedPlanId, hostingCatalog } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { HostingAccount } from './hosting-entities'
import { hostingFail } from './hosting-transactions'

export const HOSTED_WORKSPACE_CONCURRENCY = 20

// Hosted scheduling policy is independent of historical catalogue allowances
// and of the physical worker pool. Self-hosted scheduling does not use this.
export function hostedPlanLimits(planId: HostedPlanId) {
    return { ...hostingCatalog.getPlan({ planId }), concurrency: HOSTED_WORKSPACE_CONCURRENCY }
}

export async function hostedConcurrencyUsage(manager: EntityManager, account: HostingAccount): Promise<number> {
    // Billing uncertainty must keep its funded hold, not occupy execution
    // capacity forever. Only fenced, stopped trees with no live supplier call
    // qualify. Keep the stored counter and every accounting record unchanged;
    // later settlement still decrements its original counter exactly once.
    // Admission callers hold the existing account row lock across this read.
    const [row] = await manager.query<{ stopped: number }[]>(`
        SELECT count(DISTINCT r.id)::integer AS stopped
        FROM hosting_reservation r
        JOIN hosting_dispatch root ON root."reservationId" = r.id
            AND root."platformId" = r."platformId" AND root."rootDispatchId" IS NULL
        WHERE r."platformId" = $1 AND r.kind = 'execution' AND r.state IN ('running', 'uncertain')
            AND root.state IN ('completed', 'cancelled', 'uncertain')
            AND (root.state <> 'uncertain' OR root."leaseUntil" <= clock_timestamp())
            AND NOT EXISTS (
                SELECT 1 FROM hosting_dispatch segment
                WHERE segment."platformId" = r."platformId"
                    AND (segment.id = root.id OR segment."rootDispatchId" = root.id)
                    AND (segment.state IN ('prepared', 'admitted', 'running', 'paused')
                        OR (segment.state = 'uncertain' AND (segment."leaseUntil" IS NULL OR segment."leaseUntil" > clock_timestamp())))
            )
            AND NOT EXISTS (
                SELECT 1 FROM hosting_model_call call
                WHERE call."platformId" = r."platformId" AND call."rootReservationId" = r.id
                    AND (call.state IN ('prepared', 'running')
                        OR (call.state = 'uncertain' AND call."leaseUntil" > clock_timestamp()))
            )
    `, [account.id])
    if (!Number.isSafeInteger(row?.stopped) || row.stopped < 0 || row.stopped > account.activeExecutions) hostingFail('HOSTING_CONCURRENCY_STATE_INVALID')
    return account.activeExecutions - row.stopped
}
