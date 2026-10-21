import { EngineResponseStatus, TriggerHookType, WebhookHandshakeStrategy, WorkerJobType } from '@activepieces/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { origin, submit } = vi.hoisted(() => ({ origin: vi.fn(), submit: vi.fn() }))
vi.mock('../../src/app/hosting/hosting-services', () => ({ hostingServices: { execution: () => ({ resolveHostedHandshakeOrigin: origin }) } }))
vi.mock('../../src/app/project/project-service', () => ({ projectService: () => ({ getPlatformId: async () => 'platform' }) }))
vi.mock('../../src/app/workers/user-interaction-watcher', () => ({ userInteractionWatcher: { submitAndWaitForResponse: submit } }))
import { webhookHandshake } from '../../src/app/webhooks/webhook-handshake'
const logger = { info: vi.fn() } as never
const params = { flowId: 'flow', flowVersionId: 'version', projectId: 'project', simulate: true, payload: { body: {}, headers: {}, queryParams: { challenge: 'value' } }, handshakeConfiguration: { strategy: WebhookHandshakeStrategy.QUERY_PRESENT, paramName: 'challenge' }, logger }
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('AP_SERVICE_MODE', 'hosted')
    origin.mockResolvedValue({ type: 'trigger-lifecycle', admissionId: 'enable-admission' })
    submit.mockResolvedValue({ status: EngineResponseStatus.OK, response: { response: { status: 200, body: 'challenge' } } })
})
afterEach(() => vi.unstubAllEnvs())
describe('hosted provider registration handshake', () => {
    it('uses the simulated source and the exact live registration lifecycle origin', async () => {
        expect(await webhookHandshake.handleHandshakeRequest(params)).toEqual({ status: 200, body: 'challenge' })
        expect(origin).toHaveBeenCalledWith({ platformId: 'platform', projectId: 'project', flowId: 'flow', flowVersionId: 'version', test: true })
        expect(submit).toHaveBeenCalledWith(expect.objectContaining({ jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK, hookType: TriggerHookType.HANDSHAKE, test: true, flowId: 'flow', flowVersionId: 'version' }), logger, undefined, { type: 'trigger-lifecycle', admissionId: 'enable-admission' })
    })
    it('uses production source scope for production callbacks', async () => {
        origin.mockResolvedValueOnce({ type: 'scheduled' })
        await webhookHandshake.handleHandshakeRequest({ ...params, simulate: false })
        expect(origin).toHaveBeenCalledWith(expect.objectContaining({ test: false }))
        expect(submit).toHaveBeenCalledWith(expect.objectContaining({ test: false }), logger, undefined, { type: 'scheduled' })
    })
    it('preserves self-hosted handshake hook behavior', async () => {
        vi.stubEnv('AP_SERVICE_MODE', 'self_hosted')
        await webhookHandshake.handleHandshakeRequest(params)
        expect(origin).not.toHaveBeenCalled()
        expect(submit).toHaveBeenCalledWith(expect.objectContaining({ test: false }), logger, undefined, { type: 'scheduled' })
    })
})
