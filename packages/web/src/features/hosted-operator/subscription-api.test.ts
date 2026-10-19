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
import { saveOperatorSubscription } from './subscription-api';

type Session = Parameters<typeof saveOperatorSubscription>[0];
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
  name: 'Client workspace',
  planId: 'training',
  accountStatus: 'active',
  billingHold: false,
  revision: 1,
  serverTime: '2026-10-19T00:00:00.000Z',
  renewalDueAt: '2026-11-01T00:00:00.000Z',
  graceEndsAt: '2026-11-16T00:00:00.000Z',
  state: 'current',
  origin: 'override',
  effectiveRuntimeUntil: '2026-11-16T00:00:00.000Z',
  canManage: true,
  limitation: null,
  boundPeriod: null,
});
const body = {
  expectedRevision: 0,
  requestKey: 'synthetic-request',
  renewalDueAt: '2026-11-01T00:00:00.000Z',
  reason: 'Manual renewal agreement',
};
beforeEach(() => {
  mocks.current = session;
  mocks.request.mockReset();
});
describe('operator renewal request fencing', () => {
  it('posts only the explicit target, revision, due date and audit fields', async () => {
    mocks.request.mockResolvedValue(view());
    await saveOperatorSubscription(
      session,
      target,
      new AbortController().signal,
      body,
    );
    expect(mocks.request.mock.calls[0][1].data).toEqual({
      ...body,
      platformId: target,
    });
  });
  it('discards a response for another workspace', async () => {
    mocks.request.mockResolvedValue({
      ...view(),
      scopePlatformId: 'x'.repeat(21),
    });
    await expect(
      saveOperatorSubscription(
        session,
        target,
        new AbortController().signal,
        body,
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('rejects a late response after logout or identity switch', async () => {
    let resolve!: (value: unknown) => void;
    mocks.request.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const response = saveOperatorSubscription(
      session,
      target,
      new AbortController().signal,
      body,
    );
    mocks.current = null;
    resolve(view());
    await expect(response).rejects.toThrow('session changed');
  });
  it('sanitizes revision conflicts instead of exposing transport configuration', async () => {
    mocks.request.mockRejectedValue({
      response: { status: 409 },
      config: { authorization: 'synthetic-private-bearer' },
    });
    await expect(
      saveOperatorSubscription(
        session,
        target,
        new AbortController().signal,
        body,
      ),
    ).rejects.toMatchObject({ kind: 'conflict', message: 'conflict' });
  });
  it('does not send an invalid revision or empty audit reason', async () => {
    await expect(
      saveOperatorSubscription(session, target, new AbortController().signal, {
        ...body,
        expectedRevision: -1,
        reason: '',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
