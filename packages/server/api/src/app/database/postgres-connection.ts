import { isNil, spreadIfDefined } from '@activepieces/core-utils'
import { DataSource } from 'typeorm'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { BackgroundMigration } from './background-migration'
import { commonProperties } from './database-connection'
import { Migration } from './migration'
import { SydekyksInitialSchema1880000000000 } from './migration/postgres/1880000000000-SydekyksInitialSchema'
import { SydekyksUpstream1031881000000000 } from './migration/postgres/1881000000000-SydekyksUpstream103'
import { SydekyksUpstreamOctober211882000000000 } from './migration/postgres/1882000000000-SydekyksUpstreamOctober21'
import { ReshapeFlowRunListIndexesForBarrierChildren1871000000000 } from './migration/postgres/background/1871000000000-ReshapeFlowRunListIndexesForBarrierChildren'
import { BackfillPieceTranslation1874000000000 } from './migration/postgres/background/1874000000000-BackfillPieceTranslation'

import { SydekyksHostingLedger1882000000000 } from './migration/postgres/1882000000000-SydekyksHostingLedger'

import { SydekyksHostingDispatch1883000000000 } from './migration/postgres/1883000000000-SydekyksHostingDispatch'

export const getMigrations = () => [SydekyksInitialSchema1880000000000, SydekyksUpstream1031881000000000, SydekyksUpstreamOctober211882000000000, SydekyksHostingLedger1882000000000, SydekyksHostingDispatch1883000000000]

function getSslConfig() {
    return system.getBoolean(AppSystemProp.POSTGRES_USE_SSL) ? { rejectUnauthorized: true } : false
}

export const getBackgroundMigrations = (): (new () => BackgroundMigration)[] => [ReshapeFlowRunListIndexesForBarrierChildren1871000000000, BackfillPieceTranslation1874000000000]

export const createPostgresDataSource = (): DataSource => {
    const migrationConfig: MigrationConfig = {
        migrationsRun: false,
        migrationsTransactionMode: 'each',
        migrations: getMigrations(),
        synchronize: false,
    }

    const url = system.get(AppSystemProp.POSTGRES_URL)

    if (!isNil(url)) {
        return new DataSource({
            type: 'postgres',
            url,
            ssl: getSslConfig(),
            ...spreadIfDefined('poolSize', system.get(AppSystemProp.POSTGRES_POOL_SIZE)),
            ...migrationConfig,
            ...commonProperties,
        })
    }

    const database = system.getOrThrow(AppSystemProp.POSTGRES_DATABASE)
    const host = system.getOrThrow(AppSystemProp.POSTGRES_HOST)
    const password = system.getOrThrow(AppSystemProp.POSTGRES_PASSWORD)
    const serializedPort = system.getOrThrow(AppSystemProp.POSTGRES_PORT)
    const port = Number.parseInt(serializedPort, 10)
    const idleTimeoutMillis = system.getNumberOrThrow(AppSystemProp.POSTGRES_IDLE_TIMEOUT_MS)
    const username = system.getOrThrow(AppSystemProp.POSTGRES_USERNAME)

    return new DataSource({
        type: 'postgres',
        host,
        port,
        username,
        password,
        database,
        ssl: getSslConfig(),
        ...spreadIfDefined('poolSize', system.get(AppSystemProp.POSTGRES_POOL_SIZE)),
        ...commonProperties,
        ...migrationConfig,
        extra: {
            idleTimeoutMillis,
        },
    })
}


export const createPostgresMigrationDataSource = (): DataSource | null => {
    const url = system.get(AppSystemProp.POSTGRES_MIGRATION_URL)
    if (isNil(url)) return null
    return new DataSource({
        type: 'postgres',
        url,
        ssl: getSslConfig(),
        poolSize: 2,
        migrationsRun: false,
        synchronize: false,
        ...commonProperties,
    })
}

type MigrationConfig = {
    migrationsRun?: boolean
    migrationsTransactionMode?: 'all' | 'none' | 'each'
    migrations?: (new () => Migration)[]
    synchronize: false
}
