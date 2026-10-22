import { databaseConnection } from '../database/database-connection'
import { redisConnections } from '../database/redis-connections'
import { hostingConfiguration } from './hosting-configuration'
import { hostingInstallation } from './hosting-installation'

async function verify(): Promise<void> {
    const mode = hostingConfiguration.validate()
    const dataSource = databaseConnection()
    await hostingInstallation.verify({ dataSource, mode })
    hostingConfiguration.assertRuntimeAvailable({ mode })
    if (mode !== 'hosted') return
    // Normal migrations must have installed every durable accounting, fencing,
    // membership and enrollment surface before the API can accept traffic.
    const required = ['hosting_subscription', 'hosting_subscription_command', 'hosting_trainer_role', 'hosting_trainer_assignment', 'hosting_trainer_command', 'hosting_trainer_setup', 'hosting_assessment', 'hosting_recovery_binding', 'hosting_recovery_token', 'hosting_storage_lock', 'hosting_account', 'hosting_grant', 'hosting_reservation', 'hosting_ledger', 'hosting_dispatch', 'hosting_model_call', 'hosting_access_role', 'hosting_access_membership', 'hosting_training', 'lms_enrollment', 'hosting_pricing_observation', 'hosting_pricing_approval', 'hosting_pricing_state', 'hosting_managed_secret', 'hosting_managed_profile', 'hosting_managed_binding', 'hosting_ai_allowance_change', 'hosting_ai_allowance_binding', 'hosting_partner_admin_binding', 'hosting_partner_admin_command', 'hosting_partner_setup_binding', 'hosting_partner_setup_token', 'hosting_tenant_members_binding', 'hosting_tenant_members_command']
    const rows: { name: string, relation: string | null }[] = await dataSource.query('SELECT name, to_regclass(name)::text AS relation FROM unnest($1::text[]) AS name', [required])
    if (rows.some(row => !row.relation)) throw new Error('Hosted pilot accounting schema is incomplete; run the supported migrations')
    const redis = await redisConnections.useExisting()
    if (await redis.ping() !== 'PONG') throw new Error('Hosted pilot shared Redis is unavailable')
    const { initializeHostedOperatorCredits } = await import('./hosting-operator-credits')
    await initializeHostedOperatorCredits(dataSource)
}

export const hostingBootstrap = { verify }
