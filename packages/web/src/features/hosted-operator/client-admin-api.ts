import { z } from 'zod';

import { HostedCredits } from '@/features/hosted-chat/hosted-chat-api';
import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21);
export const ManagedClient = z.object({
  platformId: id,
  name: z.string(),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.object({ identityId: id, name: z.string(), email: z.string() }),
  planId: z.string(),
  status: z.string(),
  validUntil: z.string(),
  funding: z.enum(['manual', 'stripe', 'unconfirmed']),
  limits: z.object({ users: z.number(), concurrency: z.number() }),
  credits: HostedCredits,
  partners: z.array(
    z.object({ identityId: id, name: z.string(), email: z.string() }),
  ),
});
export type ManagedClient = z.infer<typeof ManagedClient>;
const Response = z.object({
  platformId: id,
  userId: id,
  client: ManagedClient,
});
export class ClientAdminError extends Error {
  constructor(
    public readonly kind: 'session' | 'denied' | 'conflict' | 'unavailable',
  ) {
    super(`Client administration ${kind}`);
  }
}
export async function requestClient(
  session: Session,
  platformId: string,
  options: {
    signal?: AbortSignal;
    profile?: {
      name: string;
      expectedState: string;
      reason: string;
      confirmed: true;
    };
  } = {},
) {
  if (session.kind !== 'user') throw new ClientAdminError('session');
  assertAuthSession(session);
  try {
    const raw = await api.sessionScoped<unknown>(
      `/v1/hosting/operator/clients/${platformId}${
        options.profile ? '/profile' : ''
      }`,
      {
        method: options.profile ? 'POST' : 'GET',
        signal: options.signal,
        ...(options.profile ? { data: options.profile } : {}),
      },
    );
    assertAuthSession(session);
    const parsed = Response.safeParse(raw);
    if (!parsed.success) throw new ClientAdminError('unavailable');
    if (
      parsed.data.platformId !== session.platformId ||
      parsed.data.userId !== session.id ||
      parsed.data.client.platformId !== platformId
    )
      throw new ClientAdminError('denied');
    return parsed.data.client;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof ClientAdminError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    throw new ClientAdminError(
      status === 409
        ? 'conflict'
        : status === 401 || status === 403 || status === 404
        ? 'denied'
        : 'unavailable',
    );
  }
}
export function managedClientQuery(
  session: Session,
  platformId: string,
  allowed: boolean,
) {
  return {
    queryKey: [
      'hosted-managed-client',
      session.epoch,
      session.platformId,
      session.id,
      platformId,
    ],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      requestClient(session, platformId, { signal }),
    enabled: allowed && /^[a-zA-Z0-9_-]{21}$/.test(platformId),
    gcTime: 0,
    staleTime: 0,
    retry: false as const,
  };
}
export function clientPlanName(planId: string) {
  return (
    (
      {
        starter: 'Starter',
        team: 'Growth',
        scale: 'Scale',
        training: 'Partner hosting',
        assessment: 'Assessment',
        trial: 'Trial',
      } as Record<string, string>
    )[planId] ?? planId
  );
}
