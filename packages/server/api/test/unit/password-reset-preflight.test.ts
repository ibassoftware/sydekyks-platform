import { createHmac } from 'node:crypto'
import { OtpState, OtpType } from '@activepieces/shared'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ row: null as Record<string, unknown> & { attempts: number, updated: string } | null, revision: 'current-revision', store: new Map<string, unknown>() }))
vi.mock('../../src/app/core/db/repo-factory', () => ({ repoFactory: () => () => ({
    findOneBy: async () => state.row ? { ...state.row } : null,
    delete: async () => {
        state.row = null 
    },
    query: async () => {
        if (state.row) state.row.attempts++ 
    },
}) }))
vi.mock('../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({ runExclusive: async ({ fn }: { fn: () => Promise<unknown> }) => fn() }),
    distributedStore: {
        get: async (key: string) => state.store.get(key) ?? null,
        put: async (key: string, value: unknown) => {
            state.store.set(key, value) 
        },
        delete: async (key: string) => {
            state.store.delete(key) 
        },
    },
}))
vi.mock('../../src/app/authentication/user-identity/user-identity-service', () => ({
    userIdentityRepository: () => ({ findOneByOrFail: async () => ({ tokenVersion: state.revision }) }),
    userIdentityService: () => ({}),
}))
vi.mock('../../src/app/sydekyks-community/email', () => ({ emailService: () => ({}) }))
vi.mock('../../src/app/helper/encryption', () => ({ encryptUtils: {
    hmacString: async (value: string) => createHmac('sha256', 'synthetic-unit-test-key').update(value).digest('hex'),
    digestsMatch: (a: string, b: string) => a === b,
} }))
import { otpService } from '../../src/app/authentication/otp/otp-service'

const identityId = 'i'.repeat(21), value = 'synthetic-reset-code'
const service = () => otpService({ warn: vi.fn() } as never)
beforeEach(() => {
    state.store.clear()
    state.revision = 'current-revision'
    state.row = { id: 'o'.repeat(21), identityId, type: OtpType.PASSWORD_RESET, state: OtpState.PENDING, attempts: 0, version: 2, updated: new Date().toISOString(), value: createHmac('sha256', 'synthetic-unit-test-key').update(`${value}:${state.revision}`).digest('hex') }
})
it('inspects valid reset credentials repeatedly and redeems them only once', async () => {
    for (let index = 0; index < 2; index++) expect(await service().isPasswordResetValid({ identityId, value })).toBe(true)
    expect(state.row?.attempts).toBe(0)
    expect(await service().confirm({ identityId, value, type: OtpType.PASSWORD_RESET })).toBe(true)
    expect(await service().isPasswordResetValid({ identityId, value })).toBe(false)
})
it('charges invalid preflight guesses to the same budget as redemption', async () => {
    for (let index = 0; index < 4; index++) expect(await service().isPasswordResetValid({ identityId, value: 'wrong' })).toBe(false)
    expect(state.row?.attempts).toBe(4)
    expect(await service().confirm({ identityId, value: 'wrong', type: OtpType.PASSWORD_RESET })).toBe(false)
    expect(await service().isPasswordResetValid({ identityId, value })).toBe(false)
    expect(state.row).toBeNull()
})
it('rejects expired links before showing a password form', async () => {
    state.row!.updated = new Date(Date.now() - 11 * 60_000).toISOString()
    expect(await service().isPasswordResetValid({ identityId, value })).toBe(false)
})
it('rejects codes from an earlier credential revision', async () => {
    state.revision = 'later-revision'
    expect(await service().isPasswordResetValid({ identityId, value })).toBe(false)
})
