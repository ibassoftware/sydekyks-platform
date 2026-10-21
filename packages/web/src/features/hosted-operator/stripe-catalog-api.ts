import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const Scope = z.object({ platformId: id, userId: id, scopePlatformId: id });
const State = Scope.extend({
  mode: z.enum(['manual', 'stripe_test']),
  state: z.enum(['manual', 'unbound', 'current', 'migration_required']),
  currentHash: hash.nullable(),
  targetHash: hash.nullable(),
  revision: z.number().int().nonnegative().nullable(),
});
const Price = z.object({
  priceId: z.string(),
  amountMinor: z.number().int().positive(),
  currency: z.literal('usd'),
});
const Preview = Scope.extend({
  previewId: id,
  expiresAt: z.iso.datetime(),
  currentHash: hash,
  targetHash: hash,
  revision: z.number().int().nonnegative(),
  accountId: z.string(),
  customerId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  subscriptionStatus: z.string().nullable(),
  plans: z.object({ starter: Price, team: Price, scale: Price }),
  retiringCommands: z.array(
    z.object({
      commandId: id,
      objectId: z.string().nullable(),
      reason: z.enum([
        'never_sent',
        'checkout_expired',
        'checkout_completed',
        'portal_delivery_retired',
      ]),
    }),
  ),
  pendingEvents: z.number().int().nonnegative(),
  retiringExpiredLease: z.boolean(),
});
export type StripeCatalogPreview = z.infer<typeof Preview>;
export class StripeCatalogError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function request<T>(
  session: Session,
  scopePlatformId: string,
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  body?: object,
): Promise<T> {
  assertAuthSession(session);
  if (session.kind !== 'user')
    throw new StripeCatalogError('HOSTING_OPERATOR_REQUIRED');
  try {
    const raw = await api.sessionScoped<unknown>(
      `/v1/hosting/operator/stripe-catalog${path}`,
      {
        method: body ? 'POST' : 'GET',
        signal,
        ...(body
          ? { data: { platformId: scopePlatformId, ...body } }
          : { params: { platformId: scopePlatformId } }),
      },
    );
    assertAuthSession(session);
    const result = schema.parse(raw);
    const bound = Scope.safeParse(result);
    if (
      bound.success &&
      (bound.data.userId !== session.id ||
        bound.data.platformId !== session.platformId ||
        bound.data.scopePlatformId !== scopePlatformId)
    )
      throw new StripeCatalogError('HOSTING_OPERATOR_REQUIRED');
    return result;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof StripeCatalogError) throw error;
    const data = api.isError(error) ? error.response?.data : null;
    const parsed = z
      .object({ code: z.string().regex(/^HOSTING_[A-Z_]+$/) })
      .safeParse(data);
    throw new StripeCatalogError(
      parsed.success ? parsed.data.code : 'HOSTING_STRIPE_CATALOG_UNAVAILABLE',
    );
  }
}
export const stripeCatalogKey = (session: Session, scopePlatformId: string) => [
  'hosted-stripe-catalog',
  session.epoch,
  session.id,
  session.platformId,
  scopePlatformId,
];
export function useStripeCatalog(
  session: Session,
  scopePlatformId: string,
  allowed: boolean,
) {
  return useQuery({
    queryKey: stripeCatalogKey(session, scopePlatformId),
    queryFn: ({ signal }) =>
      request(session, scopePlatformId, '', State, signal),
    enabled: allowed && session.kind === 'user' && !!scopePlatformId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}
export const previewStripeCatalog = (
  session: Session,
  scope: string,
  signal: AbortSignal,
) => request(session, scope, '/preview', Preview, signal, {});
export const confirmStripeCatalog = (
  session: Session,
  scope: string,
  previewId: string,
  requestKey: string,
  reason: string,
  signal: AbortSignal,
) =>
  request(
    session,
    scope,
    '/confirm',
    z.object({
      changeId: id,
      revision: z.number().int().nonnegative(),
      replayed: z.boolean(),
    }),
    signal,
    { previewId, requestKey, reason },
  );
