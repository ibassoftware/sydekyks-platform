import { HostedBillingOverview } from '@activepieces/shared';

import { api } from '@/lib/api';

import {
  assertBillingSession,
  BillingError,
  currentBillingSession,
} from './billing-session';

type Session = ReturnType<typeof currentBillingSession>;
async function safeRequest<T>(
  session: Session,
  request: () => Promise<T>,
  purchase = false,
): Promise<T> {
  assertBillingSession(session);
  try {
    const result = await request();
    assertBillingSession(session);
    return result;
  } catch (error) {
    assertBillingSession(session);
    if (error instanceof BillingError) throw error;
    // Axios errors contain authorization headers and provider details. Do not cache them.
    const status = api.isError(error) ? error.response?.status : undefined;
    const code = api.isError(error)
      ? (error.response?.data as { code?: unknown })?.code
      : undefined;
    const authorizationDenied =
      code === 'HOSTING_ACCESS_DENIED' || code === 'AUTHORIZATION';
    throw new BillingError(
      status === 401
        ? 'session'
        : status === 403 && (!purchase || authorizationDenied)
        ? 'denied'
        : 'unavailable',
    );
  }
}
export const hostedBillingApi = {
  async overview(session: Session, signal: AbortSignal) {
    const raw = await safeRequest(session, () =>
      api.get<unknown>('/v1/hosting/billing/overview', undefined, { signal }),
    );
    const parsed = HostedBillingOverview.safeParse(raw);
    if (!parsed.success) throw new BillingError('unavailable');
    if (
      parsed.data.platformId !== session?.platformId ||
      parsed.data.userId !== session?.userId
    )
      throw new BillingError('denied');
    return parsed.data;
  },
  async open(
    session: Session,
    kind: 'checkout' | 'portal',
    planId?: 'starter' | 'team',
  ) {
    const result = await safeRequest(
      session,
      () =>
        api.post<{ url: string }>(
          `/v1/hosting/billing/${kind}`,
          kind === 'checkout' ? { planId } : {},
        ),
      true,
    );
    let target: URL;
    try {
      target = new URL(result.url);
    } catch {
      throw new BillingError('action');
    }
    const host =
      kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
    if (
      target.protocol !== 'https:' ||
      target.hostname !== host ||
      target.username ||
      target.password ||
      target.port
    )
      throw new BillingError('action');
    assertBillingSession(session);
    window.location.assign(target.href);
  },
};
