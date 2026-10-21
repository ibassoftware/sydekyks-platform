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
  createManualAccount,
  readManualAccount,
  renewManualAccount,
  ManualAccountInput,
} from './manual-accounts-api';

type Session = Parameters<typeof createManualAccount>[0];
const session = {
  epoch: 'epoch',
  kind: 'user',
  id: 'u'.repeat(21),
  platformId: 'p'.repeat(21),
  expiresAt: null,
} as Session;
const target = 't'.repeat(21);
const body: ManualAccountInput = {
  requestKey: 'synthetic-only',
  companyName: 'Sample Company',
  fullName: 'Example Person',
  email: 'manual@example.invalid',
  password: 'Synthetic-only-pass',
  kind: 'client',
  planId: 'starter',
  expiresAt: '2027-01-01T00:00:00.000Z',
  reason: 'Sample authorized manual term',
};
const response = () => ({
  platformId: session.platformId,
  userId: session.id,
  replayed: false,
  account: {
    identityId: 'i'.repeat(21),
    platformId: target,
    name: body.companyName,
    email: body.email,
    planId: 'starter',
    kind: 'client',
    termId: 'f'.repeat(21),
    revision: 1,
    startsAt: '2026-10-21T00:00:00.000Z',
    expiresAt: body.expiresAt,
    graceEndsAt: '2027-01-16T00:00:00.000Z',
    monthlyCredits: 10_000,
    seats: 10,
    enrollmentId: null,
  },
});
beforeEach(() => {
  mocks.current = session;
  mocks.request.mockReset();
});
describe('manual account response and session boundaries', () => {
  it('requires the saved result to match the requested recipient and plan', async () => {
    mocks.request.mockResolvedValue({
      ...response(),
      account: { ...response().account, email: 'other@example.invalid' },
    });
    await expect(createManualAccount(session, body)).rejects.toMatchObject({
      code: 'UNCONFIRMED',
    });
  });
  it('discards a late result after logout instead of showing another session’s access', async () => {
    let resolve!: (value: unknown) => void;
    mocks.request.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = createManualAccount(session, body);
    mocks.current = null;
    resolve(response());
    await expect(pending).rejects.toThrow('session changed');
  });
  it('does not accept a read or renewal result for another tenant', async () => {
    mocks.request.mockResolvedValue({
      ...response(),
      account: { ...response().account, platformId: 'x'.repeat(21) },
    });
    await expect(readManualAccount(session, target)).rejects.toMatchObject({
      code: 'UNCONFIRMED',
    });
    await expect(
      renewManualAccount(session, target, {
        requestKey: 'renew',
        expectedRevision: 1,
        expiresAt: body.expiresAt,
        reason: body.reason,
      }),
    ).rejects.toMatchObject({ code: 'UNCONFIRMED' });
  });
  it('requires the response operator to match the authenticated operator', async () => {
    mocks.request.mockResolvedValue({ ...response(), userId: 'x'.repeat(21) });
    await expect(createManualAccount(session, body)).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
  });
});
