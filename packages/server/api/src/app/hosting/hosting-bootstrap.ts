import { databaseConnection } from '../database/database-connection'
import { hostingConfiguration } from './hosting-configuration'
import { hostingInstallation } from './hosting-installation'

async function verify(): Promise<void> {
    const mode = hostingConfiguration.validate()
    await hostingInstallation.verify({ dataSource: databaseConnection(), mode })
    hostingConfiguration.assertRuntimeAvailable({ mode })
}

export const hostingBootstrap = { verify }
