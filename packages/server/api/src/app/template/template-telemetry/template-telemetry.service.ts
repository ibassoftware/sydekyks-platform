import { TemplateTelemetryEvent } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'

// Collection is deferred. Keep template installation/activation independent of
// analytics and never forward events to the upstream vendor.
export const templateTelemetryService = (_log: FastifyBaseLogger) => ({
    sendEvent(_params: { event: TemplateTelemetryEvent, projectId: string }): void {},
    sendEventForPlatform(_params: { event: TemplateTelemetryEvent, platformId: string | null }): void {},
})
