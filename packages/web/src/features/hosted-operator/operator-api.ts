import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import {
  HostedChatError,
  HostedCredits,
} from '@/features/hosted-chat/hosted-chat-api';
import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21),
  quantity = z.string().regex(/^\d+$/);
const Access = z.object({ platformId: id, userId: id, allowed: z.boolean() });
const Clients = z.object({
  platformId: id,
  userId: id,
  next: id.nullable(),
  clients: z.array(
    z.object({
      platformId: id,
      name: z.string(),
      accountKind: z.enum(['client', 'partner', 'trial']).optional(),
      planId: z.string(),
      status: z.string(),
      validUntil: z.string(),
      activeExecutions: z.number().int().nonnegative(),
      credits: HostedCredits,
      modelCalls: z.object({
        calls: quantity,
        uncertain: quantity,
        verifiedTokens: quantity,
      }),
    }),
  ),
});
export type HostedClients = z.infer<typeof Clients>;
async function read<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  params?: unknown,
): Promise<T> {
  if (session.kind !== 'user') throw new HostedChatError('session');
  assertAuthSession(session);
  try {
    const raw = await api.sessionScoped<unknown>(path, {
      method: 'GET',
      signal,
      params,
    });
    assertAuthSession(session);
    const result = schema.safeParse(raw);
    if (!result.success) throw new HostedChatError('unavailable');
    const value = result.data as T & { userId: string; platformId: string };
    if (value.userId !== session.id || value.platformId !== session.platformId)
      throw new HostedChatError('denied');
    return result.data;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof HostedChatError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    throw new HostedChatError(
      status === 401 || status === 403 || status === 404
        ? 'denied'
        : 'unavailable',
    );
  }
}
export function useHostedOperatorAccess() {
  const hosted = useHostedBillingEnabled();
  const session = useHostedAuthSession();
  const query = useQuery({
    queryKey: [
      'hosted-operator-access',
      session.epoch,
      session.platformId,
      session.id,
    ],
    queryFn: ({ signal }) =>
      read(session, '/v1/hosting/operator/access', Access, signal),
    enabled: hosted && session.kind === 'user',
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  return {
    ...query,
    hosted,
    allowed:
      hosted &&
      session.kind === 'user' &&
      !query.error &&
      query.data?.allowed === true,
    session,
  };
}
export const operatorClientsQuery = (
  session: Session,
  after: string | null,
  allowed: boolean,
  kind: 'all' | 'client' | 'partner' | 'trial' = 'all',
) => ({
  queryKey: [
    'hosted-operator-clients',
    session.epoch,
    session.platformId,
    session.id,
    after,
    kind,
  ],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    read(
      session,
      '/v1/hosting/operator/clients',
      Clients,
      signal,
      { ...(after ? { after } : {}), kind },
    ),
  enabled: allowed,
  retry: false as const,
  gcTime: 0,
  staleTime: 0,
});
