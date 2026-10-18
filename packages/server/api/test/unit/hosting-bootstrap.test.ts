import { beforeEach, describe, expect, it, vi } from 'vitest'

const { validate, verify, runtime, connection } = vi.hoisted(() => ({
    validate: vi.fn(),
    verify: vi.fn(),
    runtime: vi.fn(),
    connection: vi.fn(),
}))

vi.mock('../../src/app/helper/system/system', () => ({ system: {} }))
vi.mock('../../src/app/database/database-connection', () => ({ databaseConnection: connection }))
vi.mock('../../src/app/hosting/hosting-configuration', () => ({ hostingConfiguration: { validate, assertRuntimeAvailable: runtime } }))
vi.mock('../../src/app/hosting/hosting-installation', () => ({ hostingInstallation: { verify } }))

import { hostingBootstrap } from '../../src/app/hosting/hosting-bootstrap'

describe('hosting bootstrap', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        validate.mockReturnValue('self_hosted')
        connection.mockReturnValue({ name: 'disposable' })
        verify.mockResolvedValue(undefined)
    })

    it('stops before database access for invalid configuration', async () => {
        validate.mockImplementation(() => { throw new Error('invalid hosting configuration') })
        await expect(hostingBootstrap.verify()).rejects.toThrow('invalid hosting configuration')
        expect(connection).not.toHaveBeenCalled()
        expect(verify).not.toHaveBeenCalled()
    })

    it('never proceeds past a mismatched database marker', async () => {
        verify.mockRejectedValue(new Error('installation mismatch'))
        await expect(hostingBootstrap.verify()).rejects.toThrow('installation mismatch')
        expect(runtime).not.toHaveBeenCalled()
    })

    it('checks installation mode before final hosted runtime validation', async () => {
        validate.mockReturnValue('hosted')
        runtime.mockImplementation(() => { throw new Error('unsafe hosted runtime configuration') })
        await expect(hostingBootstrap.verify()).rejects.toThrow('unsafe hosted runtime configuration')
        expect(verify).toHaveBeenCalledWith({ dataSource: { name: 'disposable' }, mode: 'hosted' })
        expect(verify.mock.invocationCallOrder[0]).toBeLessThan(runtime.mock.invocationCallOrder[0])
    })
})
