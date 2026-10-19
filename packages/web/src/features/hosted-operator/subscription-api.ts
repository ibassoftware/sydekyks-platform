import {
  HostedSubscriptionUpdate,
  HostedSubscriptionView,
} from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21);
export type OperatorSubscription = HostedSubscriptionView;
export class SubscriptionUiError extends Error {
  constructor(readonly kind: 'conflict' | 'denied' | 'unavailable') {
    super(kind);
  }
}
export const subscriptionKey = (session: Session, platformId: string) => [
  'hosted-subscription',
  session.epoch,
  session.id,
  session.platformId,
  platformId,
];
async function request(
  session: Session,
  platformId: string,
  signal: AbortSignal,
  body?: {
    expectedRevision: number;
    requestKey: string;
    renewalDueAt: string | null;
    reason: string;
  },
): Promise<OperatorSubscription> {
  assertAuthSession(session);
  if (session.kind !== 'user' || !id.safeParse(platformId).success)
    throw new SubscriptionUiError('denied');
  const update = body
    ? HostedSubscriptionUpdate.safeParse({ ...body, platformId })
    : null;
  if (update && !update.success) throw new SubscriptionUiError('unavailable');
  try {
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/operator/subscriptions',
      {
        method: body ? 'POST' : 'GET',
        signal,
        ...(update?.success
          ? { data: update.data }
          : { params: { platformId } }),
      },
    );
    assertAuthSession(session);
    const value = HostedSubscriptionView.safeParse(raw);
    if (
      !value.success ||
      value.data.platformId !== session.platformId ||
      value.data.userId !== session.id ||
      value.data.scopePlatformId !== platformId
    )
      throw new SubscriptionUiError('unavailable');
    return value.data;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof SubscriptionUiError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    throw new SubscriptionUiError(
      status === 409
        ? 'conflict'
        : [401, 403, 404].includes(status ?? 0)
        ? 'denied'
        : 'unavailable',
    );
  }
}
export function useOperatorSubscription(
  session: Session,
  platformId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: subscriptionKey(session, platformId),
    queryFn: ({ signal }) => request(session, platformId, signal),
    enabled: enabled && id.safeParse(platformId).success,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 30_000,
  });
}
export const saveOperatorSubscription = request;
