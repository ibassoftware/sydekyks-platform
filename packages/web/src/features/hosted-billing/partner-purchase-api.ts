import { z } from 'zod';

import { api } from '@/lib/api';

import {
  assertBillingSession,
  BillingError,
  currentBillingSession,
} from './billing-session';

type Session = ReturnType<typeof currentBillingSession>;
export type PartnerPackage = 'core' | 'guided';
const PartnerStatus = z.object({
  platformId: z.string(),
  userId: z.string(),
  billingMode: z.enum(['manual', 'stripe_test']),
  available: z.boolean(),
  reason: z.string().nullable(),
  purchase: z
    .object({
      package: z.enum(['core', 'guided']),
      state: z.enum([
        'prepared',
        'ready',
        'fulfilled',
        'refunded',
        'expired',
        'review',
      ]),
      accessUntil: z.string().nullable(),
      refundedMinor: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type PartnerPurchaseStatus = z.infer<typeof PartnerStatus>;
async function guarded<T>(
  session: Session,
  operation: () => Promise<T>
): Promise<T> {
  assertBillingSession(session);
  try {
    const value = await operation();
    assertBillingSession(session);
    return value;
  } catch (error) {
    assertBillingSession(session);
    if (error instanceof BillingError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    const code = api.isError(error)
      ? (error.response?.data as { code?: string })?.code
      : undefined;
    throw new BillingError(
      status === 401
        ? 'session'
        : code === 'HOSTING_ACCESS_DENIED'
        ? 'denied'
        : 'unavailable'
    );
  }
}
export const partnerPurchaseApi = {
  async status(session: Session, signal: AbortSignal) {
    const raw = await guarded(session, () =>
      api.get<unknown>('/v1/hosting/partner-billing', undefined, { signal })
    );
    const parsed = PartnerStatus.safeParse(raw);
    if (!parsed.success) throw new BillingError('unavailable');
    if (
      parsed.data.platformId !== session?.platformId ||
      parsed.data.userId !== session?.userId
    )
      throw new BillingError('denied');
    return parsed.data;
  },
  async checkout(session: Session, selected: PartnerPackage) {
    const value = await guarded(session, () =>
      api.post<{ url: string | null; state: string }>(
        '/v1/hosting/partner-billing/checkout',
        { package: selected }
      )
    );
    if (!value.url) return;
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      throw new BillingError('action');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'checkout.stripe.com' ||
      url.port ||
      url.username ||
      url.password
    )
      throw new BillingError('action');
    assertBillingSession(session);
    window.location.assign(url.href);
  },
};
