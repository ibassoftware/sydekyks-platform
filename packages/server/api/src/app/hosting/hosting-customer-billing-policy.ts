import { User } from '@activepieces/shared'
import { hostingOperatorIdentityIds, isOperationalUser } from './hosting-access-policy'
import { HostingAccount } from './hosting-entities'
import { HostingActor, hostingFail } from './hosting-transactions'

// Customer payment authority is distinct from client implementation access.
// Assigned Partners may administer a client, but cannot create payment sessions.
export function assertCustomerBillingUser(user: Pick<User, 'externalId' | 'identityId'>): void {
    if (isOperationalUser(user) || hostingOperatorIdentityIds().includes(user.identityId)) hostingFail('HOSTING_CUSTOMER_BILLING_REQUIRED')
}

export function assertClientSubscriptionUser(account: HostingAccount, user: Pick<User, 'externalId' | 'identityId'>, actor: HostingActor): void {
    assertCustomerBillingUser(user)
    if (user.identityId !== actor.identityId || account.planId === 'training' || account.planId === 'assessment') hostingFail('HOSTING_CUSTOMER_BILLING_REQUIRED')
}
