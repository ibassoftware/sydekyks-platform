// Initialize only the disposable PostgreSQL database used by release CI.
require('dotenv').config({ path: 'packages/server/api/.env.tests' });

if (process.env.AP_ENVIRONMENT !== 'test'
    || process.env.AP_DB_TYPE !== 'POSTGRES'
    || !['127.0.0.1', 'localhost'].includes(process.env.AP_POSTGRES_HOST)
    || process.env.AP_POSTGRES_DATABASE !== 'sydekyks_ci'
    || process.env.AP_POSTGRES_URL) {
    throw new Error('Release tests must use the isolated local sydekyks_ci database');
}

const { initializeDatabase } = require('../packages/server/api/dist/src/app/database');
const { databaseConnection } = require('../packages/server/api/dist/src/app/database/database-connection');

initializeDatabase({ runMigrations: true })
    .then(() => databaseConnection().destroy())
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
