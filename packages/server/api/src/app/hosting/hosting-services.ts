import { databaseConnection } from '../database/database-connection'
import { encryptUtils } from '../helper/encryption'
import { createHostedAiGateway } from './hosting-ai-gateway'
import { createHostedBillingView } from './hosting-billing-view'
import { createHostedExecution } from './hosting-execution'
import { createHostedLedger } from './hosting-ledger'
import { createHostedOnboarding } from './hosting-onboarding'
import { createHostedPartnerBilling } from './hosting-partner-billing'
import { createHostedStripe } from './hosting-stripe'
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
function gateway() {
    return createHostedAiGateway({ dataSource: databaseConnection() })
}
async function billing() {
    return createHostedStripe({ dataSource: databaseConnection() })
}
async function partnerBilling() {
    return createHostedPartnerBilling({ dataSource: databaseConnection() })
}
function billingView() {
    return createHostedBillingView({ dataSource: databaseConnection() })
}
export const hostingServices = { onboarding, ledger, execution, gateway, billing, billingView, partnerBilling }
