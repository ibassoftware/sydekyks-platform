import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  current: null as unknown,
}));
vi.mock('@/lib/api', () => ({
  api: {
    sessionScoped: mocks.request,
    isError: (error: unknown) => !!(error as { response?: unknown })?.response,
  },
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  assertAuthSession: (session: unknown) => {
    if (mocks.current !== session) throw new Error('session changed');
  },
}));
import {
  creditAllowanceKey,
  saveCreditAllowance,
} from './credit-allowance-api';

type Session = Parameters<typeof saveCreditAllowance>[0];
const session = {
  epoch: 'epoch',
  kind: 'user',
  id: 'u'.repeat(21),
  platformId: 'p'.repeat(21),
  expiresAt: null,
} as Session;
const target = 't'.repeat(21);
const view = () => ({
  platformId: session.platformId,
  userId: session.id,
  scopePlatformId: target,
  revision: 1,
  planId: 'training',
  overrideMonthlyCredits: 15000,
  defaultMonthlyCredits: 10000,
  effectiveMonthlyCredits: 15000,
  appliesToCurrentPeriod: true,
  fixed: false,
  period: {
    validFrom: '2026-10-20T00:00:00.000Z',
    validUntil: '2026-11-20T00:00:00.000Z',
    amount: '15000',
    consumed: '3',
    reserved: '2',
    available: '14995',
  },
});
const save = () =>
  saveCreditAllowance(
    session,
    target,
    0,
    15000,
    'Agreed client allowance',
    new AbortController().signal
  );
beforeEach(() => {
  mocks.current = session;
  mocks.request.mockReset();
});
describe('operator shared Credit request fencing', () => {
  it('posts an absolute allowance, target, CAS revision and audit fields to the new Credits endpoint', async () => {
    mocks.request.mockResolvedValue(view());
    await save();
    expect(mocks.request.mock.calls[0][0]).toBe(
      '/v1/hosting/operator/credits-allowance'
    );
    expect(mocks.request.mock.calls[0][1].data).toMatchObject({
      platformId: target,
      expectedRevision: 0,
      monthlyCredits: 15000,
      reason: 'Agreed client allowance',
      requestKey: expect.any(String),
    });
    expect(mocks.request.mock.calls[0][1].data).not.toHaveProperty(
      'amountMicroUsd'
    );
    expect(creditAllowanceKey(session, target)).toContain(session.epoch);
  });
  it.each(['scopePlatformId', 'platformId', 'userId'] as const)(
    'discards a response for a different %s',
    async (field) => {
      mocks.request.mockResolvedValue({ ...view(), [field]: 'x'.repeat(21) });
      await expect(save()).rejects.toMatchObject({ kind: 'unavailable' });
    }
  );
  it('rejects a late response after logout or identity switch', async () => {
    let resolve!: (value: unknown) => void;
    mocks.request.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const response = save();
    mocks.current = null;
    resolve(view());
    await expect(response).rejects.toThrow('session changed');
  });
  it('sanitizes committed-floor conflicts without retaining transport credentials', async () => {
    mocks.request.mockRejectedValue({
      response: {
        status: 409,
        data: { code: 'HOSTING_CREDIT_ALLOWANCE_BELOW_COMMITTED' },
      },
      config: { authorization: 'synthetic-private-token' },
    });
    const result = await save().catch((error) => error);
    expect(result).toMatchObject({ kind: 'conflict' });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-token');
    expect(result).not.toHaveProperty('config');
  });
});
