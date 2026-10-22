import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  current: null as unknown,
}));
vi.mock('@/lib/api', () => ({
  api: {
    post: mocks.post,
    get: mocks.get,
    isError: (error: unknown) =>
      !!error && typeof error === 'object' && 'response' in error,
  },
}));
vi.mock('./billing-session', () => ({
  currentBillingSession: () => mocks.current,
  assertBillingSession: (session: unknown) => {
    if (!session || session !== mocks.current)
      throw new Error('session changed');
  },
  BillingError: class extends Error {
    constructor(public kind: string) {
      super(kind);
    }
  },
}));
import { hostedBillingApi } from './billing-api';
const session = {
  epoch: 'synthetic-session',
  platformId: 'p'.repeat(21),
  userId: 'u'.repeat(21),
  expiresAt: Date.now() + 60_000,
};
const receipt = {
  platformId: session.platformId,
  userId: session.userId,
  planId: 'team',
  effectiveAt: '2026-11-22T00:00:00.000Z',
  timing: 'next_renewal',
};
beforeEach(() => {
  mocks.current = session;
  mocks.post.mockReset();
  mocks.get.mockReset();
});
describe('session-pinned client plan changes', () => {
  it('sends a fixed catalogue target and accepts a renewal-only receipt', async () => {
    mocks.post.mockResolvedValue(receipt);
    expect(await hostedBillingApi.changePlan(session, 'team')).toEqual(receipt);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/hosting/billing/change-plan',
      { planId: 'team' },
    );
  });
  it.each([
    { planId: 'starter' },
    { timing: 'immediate' },
    { effectiveAt: 'not-a-date' },
  ])(
    'rejects a mismatched or malformed provider-independent receipt',
    async (delta) => {
      mocks.post.mockResolvedValue({ ...receipt, ...delta });
      await expect(
        hostedBillingApi.changePlan(session, 'team'),
      ).rejects.toMatchObject({ kind: 'action' });
    },
  );
  it.each([{ platformId: 'x'.repeat(21) }, { userId: 'x'.repeat(21) }])(
    'rejects a response for a different client or user',
    async (delta) => {
      mocks.post.mockResolvedValue({ ...receipt, ...delta });
      await expect(
        hostedBillingApi.changePlan(session, 'team'),
      ).rejects.toMatchObject({ kind: 'denied' });
    },
  );
  it('does not apply a late result after the client or identity changes', async () => {
    mocks.post.mockImplementation(async () => {
      mocks.current = { ...session, epoch: 'new-session' };
      return receipt;
    });
    await expect(hostedBillingApi.changePlan(session, 'team')).rejects.toThrow(
      'session changed',
    );
  });
  it('denies before sending when the session has already changed', async () => {
    mocks.current = null;
    await expect(hostedBillingApi.changePlan(session, 'team')).rejects.toThrow(
      'session changed',
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([
    'HOSTING_CUSTOMER_BILLING_REQUIRED',
    'HOSTING_ACCESS_DENIED',
    'AUTHORIZATION',
  ])('does not treat %s as a recoverable purchase action', async (code) => {
    mocks.post.mockRejectedValue({
      response: { status: 403, data: { code } },
      config: { headers: { Authorization: 'private-marker' } },
    });
    const result = hostedBillingApi.changePlan(session, 'team');
    await expect(result).rejects.toMatchObject({ kind: 'denied' });
    await expect(result).rejects.not.toHaveProperty('config');
  });
});
