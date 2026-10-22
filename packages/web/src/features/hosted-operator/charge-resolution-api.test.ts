import { beforeEach, expect, it, vi } from 'vitest';

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
    if (mocks.current !== session) throw Error('session changed');
  },
}));
import { previewCharge, resolveCharge } from './charge-resolution-api';
const session = {
  epoch: 'operator-session',
  kind: 'user' as const,
  id: 'u'.repeat(21),
  platformId: 'p'.repeat(21),
  expiresAt: null,
};
const target = 't'.repeat(21),
  callId = 'c'.repeat(21),
  root = 'r'.repeat(21);
const draft = {
  platformId: target,
  rootReservationId: root,
  outcome: 'confirmed_not_sent' as const,
  reason: 'Supplier audit confirms request was not received',
  evidenceReference: 'Synthetic local supplier receipt #123',
};
function response() {
  return {
    view: {
      identity: {
        userId: session.id,
        platformId: session.platformId,
        identityId: 'i'.repeat(21),
        tokenVersion: null,
      },
      callId,
      platformId: target,
      projectId: 'j'.repeat(21),
      rootReservationId: root,
      payer: 'managed',
      state: 'uncertain',
      revision: 0,
      stateHash: 'a'.repeat(64),
      heldCredits: '10',
      heldSupplierMicroUsd: '2500',
      accountingVersion: 'single-credits-250-microusd-v2',
      microUsdPerCredit: '250',
      leaseUntil: '2026-10-21T00:00:00Z',
      canResolve: true,
      blockers: [],
      history: [],
    },
    preview: {
      expectedRevision: 0,
      expectedState: 'b'.repeat(64),
      actualMicroUsd: '0',
      actualCredits: '0',
      releasedCredits: '10',
      releasedSupplierMicroUsd: '2500',
      rootWillSettle: true,
      blockers: [],
    },
  };
}
beforeEach(() => {
  mocks.current = session;
  mocks.request.mockReset();
});
it.each(['user', 'scope', 'call'] as const)(
  'rejects a preview for another %s',
  async (field) => {
    const value = response();
    if (field === 'user') value.view.identity.userId = 'x'.repeat(21);
    if (field === 'scope') value.view.platformId = 'x'.repeat(21);
    if (field === 'call') value.view.callId = 'x'.repeat(21);
    mocks.request.mockResolvedValue(value);
    await expect(
      previewCharge(session, callId, draft, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SESSION' });
  },
);
it('discards a late preview when the operator session changes', async () => {
  let complete!: (value: unknown) => void;
  mocks.request.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const pending = previewCharge(
    session,
    callId,
    draft,
    new AbortController().signal,
  );
  mocks.current = null;
  complete(response());
  await expect(pending).rejects.toThrow('session changed');
});
it('keeps the same idempotency key and server preview fences when retrying a confirmation', async () => {
  const value = response();
  mocks.request.mockResolvedValue({
    view: value.view,
    replayed: true,
    auditId: 'a'.repeat(21),
  });
  for (let i = 0; i < 2; i++)
    await resolveCharge(
      session,
      callId,
      draft,
      value.preview,
      'one-confirmation',
      new AbortController().signal,
    );
  expect(mocks.request.mock.calls[0][1].data).toEqual(
    mocks.request.mock.calls[1][1].data,
  );
  expect(mocks.request.mock.calls[0][1].data).toMatchObject({
    requestKey: 'one-confirmation',
    expectedState: value.preview.expectedState,
    expectedRevision: 0,
  });
  expect(mocks.request.mock.calls[0][1].data).not.toHaveProperty(
    'actualMicroUsd',
  );
});
it('sanitizes transport errors without retaining supplier keys or session headers', async () => {
  mocks.request.mockRejectedValue({
    response: {
      status: 409,
      data: { code: 'HOSTING_CHARGE_RESOLUTION_CONFLICT' },
    },
    config: { authorization: 'private-fixture-token' },
  });
  const error = await previewCharge(
    session,
    callId,
    draft,
    new AbortController().signal,
  ).catch((value) => value);
  expect(error.code).toBe('HOSTING_CHARGE_RESOLUTION_CONFLICT');
  expect(JSON.stringify(error)).not.toContain('private-fixture-token');
  expect(error).not.toHaveProperty('config');
});
it.each([true, false])(
  'sends a verified native tool billable decision of %s without inventing token usage',
  async (billable) => {
    const value = response();
    mocks.request.mockResolvedValue({
      ...value,
      view: {
        ...value.view,
        nativeTool: 'search',
        toolUnitPriceMicroUsd: '750',
        toolTariffVersion: 'deepseek-search-fetch-success-v1',
      },
    });
    const nativeDraft = {
      ...draft,
      outcome: 'verified_usage' as const,
      billable,
      supplierRequestId: 'synthetic-search-receipt',
      supplierCreatedAt: '2026-10-21T00:00:00Z',
    };
    const result = await previewCharge(
      session,
      callId,
      nativeDraft,
      new AbortController().signal,
    );
    expect(result.view.nativeTool).toBe('search');
    expect(mocks.request.mock.calls[0][1].data).toMatchObject({
      billable,
      outcome: 'verified_usage',
    });
    expect(mocks.request.mock.calls[0][1].data).not.toHaveProperty('usage');
  },
);

it('retains root-wide totals separately from the marginal resolution charge', async () => {
  const value = response();
  mocks.request.mockResolvedValue({
    ...value,
    view: {
      ...value.view,
      creditScope: 'execution_root',
      rootConsumedCredits: '1',
      rootReservedCredits: '3',
      rootTotalCredits: '4',
    },
    preview: {
      ...value.preview,
      creditScope: 'execution_root',
      actualCredits: '0',
      releasedCredits: '3',
      rootConsumedCredits: '1',
      rootReservedCredits: '0',
      rootTotalCredits: '1',
    },
  });
  const result = await previewCharge(
    session,
    callId,
    draft,
    new AbortController().signal,
  );
  expect(result.preview).toMatchObject({
    creditScope: 'execution_root',
    actualCredits: '0',
    releasedCredits: '3',
    rootConsumedCredits: '1',
    rootTotalCredits: '1',
  });
  expect(result.view.rootReservedCredits).toBe('3');
});
