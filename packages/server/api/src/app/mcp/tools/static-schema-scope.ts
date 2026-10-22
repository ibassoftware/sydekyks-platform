import { AsyncLocalStorage } from 'node:async_hooks'

// Explicitly inherited by builder metadata/configuration operations only.
export const staticMcpSchemaScope = new AsyncLocalStorage<boolean>()
