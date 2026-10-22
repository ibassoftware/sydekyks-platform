import { AuthenticationResponse } from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import {
  assertAuthSession,
  HostedAuthError,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21);
const Workspaces = z.object({
  platformId: id,
  userId: id,
  operational: z.boolean(),
  role: z.enum(['partner', 'team']).nullable(),
  workspaces: z
    .array(z.object({ platformId: id, name: z.string(), home: z.boolean() }))
    .max(100),
});

async function request(
  session: Session,
  path: string,
  signal: AbortSignal,
  method: 'GET' | 'POST',
) {
  assertAuthSession(session);
  try {
    const response = await api.sessionScoped<unknown>(path, { method, signal });
    assertAuthSession(session);
    return response;
  } catch (error) {
    assertAuthSession(session);
    const status = api.isError(error) ? error.response?.status : undefined;
    // Axios configs contain bearer credentials; retain only a bounded error.
    throw new HostedAuthError(
      status === 401 || status === 403 || status === 404
        ? 'denied'
        : 'unavailable',
    );
  }
}

export function useOperationalWorkspaces() {
  const session = useHostedAuthSession();
  const hosted = useHostedBillingEnabled();
  const query = useQuery({
    queryKey: [
      'hosted-operational-workspaces',
      session.epoch,
      session.id,
      session.platformId,
    ],
    queryFn: async ({ signal }) => {
      if (session.kind !== 'user') throw new HostedAuthError('session');
      assertAuthSession(session);
      const raw = await request(
        session,
        '/v1/hosting/operator/workspaces',
        signal,
        'GET',
      );
      assertAuthSession(session);
      const result = Workspaces.safeParse(raw);
      if (!result.success) throw new HostedAuthError('unavailable');
      if (
        result.data.userId !== session.id ||
        result.data.platformId !== session.platformId
      )
        throw new HostedAuthError('denied');
      return result.data;
    },
    enabled: hosted && session.kind === 'user',
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  return {
    ...query,
    session,
    hosted,
    allowed:
      hosted &&
      session.kind === 'user' &&
      !query.error &&
      query.data?.role !== null &&
      query.data?.role !== undefined,
  };
}

export async function enterOperationalWorkspace(
  session: Session,
  platformId: string,
  signal: AbortSignal,
) {
  if (session.kind !== 'user' || !id.safeParse(platformId).success)
    throw new HostedAuthError('session');
  assertAuthSession(session);
  const raw = await request(
    session,
    `/v1/hosting/operator/workspaces/${encodeURIComponent(platformId)}/enter`,
    signal,
    'POST',
  );
  assertAuthSession(session);
  const response = AuthenticationResponse.safeParse(raw);
  if (!response.success || response.data.platformId !== platformId)
    throw new HostedAuthError('unavailable');
  return response.data;
}
