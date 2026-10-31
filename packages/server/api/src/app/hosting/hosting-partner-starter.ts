import { HOSTED_PARTNER_STARTER_MONTHLY_CREDITS } from '@activepieces/shared'
import { EntityManager } from 'typeorm'
import { HostingManualAccountEntity } from './hosting-manual-accounts-entities'
import { hostingFail } from './hosting-transactions'

export async function isPartnerStarter(manager: EntityManager, platformId: string): Promise<boolean> {
    return manager.getRepository(HostingManualAccountEntity).existsBy({ id: platformId, kind: 'partner', package: 'starter' })
}
export async function assertPartnerStarterAllowance(manager: EntityManager, platformId: string, monthlyCredits: number | null | undefined) {
    if (monthlyCredits != null && monthlyCredits > HOSTED_PARTNER_STARTER_MONTHLY_CREDITS && await isPartnerStarter(manager, platformId)) hostingFail('HOSTING_PARTNER_STARTER_CREDIT_CAP')
}
