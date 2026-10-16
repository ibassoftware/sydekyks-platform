import { databaseConnection } from '../database/database-connection'
import { encryptUtils } from '../helper/encryption'
import { createHostedExecution } from './hosting-execution'
import { createHostedLedger } from './hosting-ledger'
import { createHostedOnboarding } from './hosting-onboarding'
import { hostingFail } from './hosting-transactions'

async function onboarding() {
    const subjectSecret = await encryptUtils.getEncryptionKey()
    if (!subjectSecret) hostingFail('HOSTING_SUBJECT_SECRET_REQUIRED')
    return createHostedOnboarding({ dataSource: databaseConnection(), subjectSecret })
}

function ledger() {
    return createHostedLedger({ dataSource: databaseConnection() })
}
function execution() {
    return createHostedExecution({ dataSource: databaseConnection() })
}
export const hostingServices = { onboarding, ledger, execution }
