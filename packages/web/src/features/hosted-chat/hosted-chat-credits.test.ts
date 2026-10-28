import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { kind: 'user', platformId: 'platform', id: 'user', epoch: 1 },
  request: vi.fn(),
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  currentAuthSession: () => mocks.session,
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getProjectId: () => 'project' },
}));
vi.mock('@/lib/api', () => ({
  api: {
    sessionScoped: mocks.request,
    isError: (value: unknown) => !!(value as { response?: unknown })?.response,
  },
}));

import { hostedChatRequest, HostedChatScope } from './hosted-chat-api';

const scope = {
  session: mocks.session,
  projectPointer: 'project',
  conversationId: null,
} as unknown as HostedChatScope;
beforeEach(() => {
  mocks.request.mockReset();
});

describe('single Credits refusal messages', () => {
  it.each([
    { status: 403, data: { code: 'HOSTING_CHAT_CONTEXT_LIMIT' } },
    { status: 413, data: { code: 'FST_ERR_CTP_BODY_TOO_LARGE' } },
  ])(
    'identifies a known pre-run context refusal instead of an unknown send outcome',
    async (response) => {
      mocks.request.mockRejectedValue({ response });
      await expect(
        hostedChatRequest(scope, '/v1/example', { method: 'POST' }, true),
      ).rejects.toMatchObject({
        kind: 'context',
        message: expect.stringContaining(
          'No Credits were charged for this send',
        ),
      });
    },
  );
  it('keeps a transport failure uncertain rather than claiming the request was free', async () => {
    mocks.request.mockRejectedValue(new Error('Network connection lost'));
    await expect(
      hostedChatRequest(scope, '/v1/example', { method: 'POST' }, true),
    ).rejects.toMatchObject({
      kind: 'send',
      message: expect.stringContaining('could not be confirmed'),
    });
  });
  it('identifies a definitively unsent expired attachment and gives a recovery action', async () => {
    mocks.request.mockRejectedValue({ response: { status: 410, data: {} } });
    await expect(
      hostedChatRequest(scope, '/v1/example', { method: 'POST' }, true),
    ).rejects.toMatchObject({
      kind: 'file',
      message: expect.stringContaining('No Credits were charged for this send'),
    });
  });
  it('distinguishes the platform emergency pause from a customer balance problem', async () => {
    mocks.request.mockRejectedValue({
      response: {
        status: 403,
        data: { code: 'HOSTING_OPERATOR_BUDGET_EXHAUSTED' },
      },
    });
    await expect(
      hostedChatRequest(scope, '/v1/example', { method: 'POST' }),
    ).rejects.toMatchObject({ kind: 'budget' });
  });
  it('identifies a wallet shortfall without claiming that an earlier execution was free', async () => {
    mocks.request.mockRejectedValue({
      response: { status: 403, data: { code: 'HOSTING_CREDITS_EXHAUSTED' } },
    });
    await expect(
      hostedChatRequest(scope, '/v1/example', { method: 'POST' }),
    ).rejects.toMatchObject({ kind: 'credits' });
  });
  it('distinguishes the run spending ceiling from account expiration', async () => {
    mocks.request.mockRejectedValue({
      response: { status: 403, data: { code: 'HOSTING_RUN_CREDIT_LIMIT' } },
    });
    await expect(
      hostedChatRequest(scope, '/v1/example', { method: 'POST' }),
    ).rejects.toMatchObject({ kind: 'limit' });
    mocks.request.mockRejectedValue({
      response: { status: 403, data: { code: 'HOSTING_ENTITLEMENT_EXPIRED' } },
    });
    await expect(
      hostedChatRequest(scope, '/v1/example', { method: 'POST' }),
    ).rejects.toMatchObject({ kind: 'access' });
  });
});
