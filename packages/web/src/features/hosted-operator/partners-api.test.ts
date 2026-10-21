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
import { partnersQuery } from './partners-api';
type Session = Parameters<typeof partnersQuery>[0];
const session = {
  epoch: 'directory-session',
  kind: 'user',
  id: 'u'.repeat(21),
  platformId: 'p'.repeat(21),
  expiresAt: null,
} as Session;
const response = {
  platformId: session.platformId,
  userId: session.id,
  total: 105,
  partners: [],
  next: 'n'.repeat(21),
};
beforeEach(() => {
  mocks.current = session;
  mocks.request.mockReset();
});
describe('Partner directory boundaries', () => {
  it('sends search and access status to the server with a cursor and keys each result separately', async () => {
    mocks.request.mockResolvedValue(response);
    const query = partnersQuery(session, 'c'.repeat(21), true, {
      search: 'iBAS',
      status: 'pending',
    });
    const signal = new AbortController().signal;
    expect(await query.queryFn({ signal })).toMatchObject({ total: 105 });
    expect(mocks.request).toHaveBeenCalledWith(
      '/v1/hosting/operator/partners',
      {
        params: { after: 'c'.repeat(21), search: 'iBAS', status: 'pending' },
        signal,
      },
    );
    expect(query.queryKey).not.toEqual(
      partnersQuery(session, null, true, { search: 'iBAS', status: 'active' })
        .queryKey,
    );
  });
  it('does not return directory data from another operator or a late result after logout', async () => {
    mocks.request.mockResolvedValue({ ...response, userId: 'x'.repeat(21) });
    await expect(
      partnersQuery(session, null, true).queryFn({
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'denied' });
    let resolve!: (value: unknown) => void;
    mocks.request.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = partnersQuery(session, null, true).queryFn({
      signal: new AbortController().signal,
    });
    mocks.current = null;
    resolve(response);
    await expect(pending).rejects.toThrow('session changed');
  });
});
