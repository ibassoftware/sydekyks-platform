import { EntityManager, IsNull, Not } from 'typeorm'
import { HostingManualAccountEntity } from './hosting-manual-accounts-entities'
import { HostingPartnerSetupTokenEntity } from './hosting-partner-setup-entities'
import { HostingTenantMembersCommandEntity } from './hosting-tenant-members-entities'
import { HostingTrainerSetupEntity } from './hosting-trainer-entities'

// verified is legacy login eligibility. Attribution must never turn a manual
// operator, client-admin or trainer admission into a claim of inbox ownership.
export async function identityAdmission(manager: EntityManager, identity: { id: string, verified: boolean }) {
    if (!identity.verified) return { verificationMethod: 'pending' as const, admissionSource: 'pending' as const, emailOwnershipVerified: false }
    const trainer = await manager.getRepository(HostingTrainerSetupEntity).existsBy({ identityId: identity.id, usedAt: Not(IsNull()) })
    const client = await manager.getRepository(HostingTenantMembersCommandEntity).existsBy({ identityId: identity.id, mode: 'setup', usedAt: Not(IsNull()) })
    const manual = await manager.getRepository(HostingManualAccountEntity).existsBy({ identityId: identity.id })
    const operator = manual || await manager.getRepository(HostingPartnerSetupTokenEntity).existsBy({ identityId: identity.id, usedAt: Not(IsNull()) })
    return { verificationMethod: trainer || client || operator ? 'operator' as const : 'email' as const, admissionSource: trainer ? 'trainer' as const : client ? 'tenant_admin' as const : operator ? 'operator' as const : 'email' as const, emailOwnershipVerified: !trainer && !client && !operator }
}
