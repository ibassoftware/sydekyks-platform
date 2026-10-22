// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  current: null as unknown,
}));
vi.mock('@/lib/api', () => ({
  api: { sessionScoped: mocks.request, isError: () => false },
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  assertAuthSession: (session: unknown) => {
    if (session !== mocks.current) throw new Error('session changed');
  },
}));
import {
  clientPlanName,
  managedClientQuery,
  requestClient,
} from './client-admin-api';
import { operatorClientsQuery } from './operator-api';
type Session = Parameters<typeof requestClient>[0];
const session = {
  kind: 'user',
  epoch: 'operator-session',
  id: 'u'.repeat(21),
  platformId: 'p'.repeat(21),
} as Session;
const target = 'c'.repeat(21);
const meter = {
  scale: '1',
  amount: '10000',
  consumed: '0',
  reserved: '0',
  available: '10000',
  validUntil: null,
};
const client = {
  platformId: target,
  name: 'Moonlight Bakery',
  stateHash: 'a'.repeat(64),
  owner: {
    identityId: 'i'.repeat(21),
    name: 'Test Owner',
    email: 'owner@test.invalid',
  },
  planId: 'team',
  status: 'active',
  validUntil: '2027-01-01T00:00:00Z',
  funding: 'manual',
  limits: { users: 30, concurrency: 5 },
  credits: { execution: meter, ai: meter, previousHeldAi: '0' },
  partners: [],
};
beforeEach(() => {
  mocks.current = session;
  mocks.request.mockReset();
});
describe('persistent client context', () => {
  it('binds a direct client request to the operator and selected client', async () => {
    mocks.request.mockResolvedValue({
      platformId: session.platformId,
      userId: session.id,
      client,
    });
    expect(await requestClient(session, target)).toEqual(client);
    mocks.request.mockResolvedValue({
      platformId: session.platformId,
      userId: session.id,
      client: { ...client, platformId: 'x'.repeat(21) },
    });
    await expect(requestClient(session, target)).rejects.toMatchObject({
      kind: 'denied',
    });
  });
  it('pins profile writes to the revision and disallows late session results', async () => {
    const profile = {
      name: 'New name',
      reason: 'Company rename',
      expectedState: client.stateHash,
      confirmed: true as const,
    };
    mocks.request.mockResolvedValue({
      platformId: session.platformId,
      userId: session.id,
      client,
    });
    await requestClient(session, target, { profile });
    expect(mocks.request).toHaveBeenCalledWith(
      `/v1/hosting/operator/clients/${target}/profile`,
      { method: 'POST', signal: undefined, data: profile },
    );
    mocks.request.mockImplementation(async () => {
      mocks.current = null;
      return { platformId: session.platformId, userId: session.id, client };
    });
    await expect(requestClient(session, target)).rejects.toThrow(
      'session changed',
    );
  });
  it('separates account-type pages in the cache and sends the filter before pagination', async () => {
    const clients = operatorClientsQuery(
      session,
      'n'.repeat(21),
      true,
      'client',
    );
    expect(clients.queryKey).not.toEqual(
      operatorClientsQuery(session, 'n'.repeat(21), true, 'partner').queryKey,
    );
    mocks.request.mockResolvedValue({
      platformId: session.platformId,
      userId: session.id,
      clients: [],
      next: null,
    });
    await clients.queryFn({ signal: new AbortController().signal });
    expect(mocks.request.mock.calls[0][1].params).toEqual({
      after: 'n'.repeat(21),
      kind: 'client',
    });
    expect(managedClientQuery(session, '', true).enabled).toBe(false);
    expect(clientPlanName('team')).toBe('Growth');
  });
});
