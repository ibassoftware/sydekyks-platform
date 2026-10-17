import { jwtDecode } from 'jwt-decode';
import { useSyncExternalStore } from 'react';

import { authenticationSession } from '@/lib/authentication-session';

type BillingSession = Readonly<{
  epoch: string;
  platformId: string;
  userId: string;
  expiresAt: number;
}>;
let observedToken: string | null = null;
let snapshot: BillingSession | null = null;

// The JWT is kept outside React Query keys, telemetry, and rendered state.
export function currentBillingSession(): BillingSession | null {
  const token = authenticationSession.getToken();
  if (
    token === observedToken &&
    (!snapshot || snapshot.expiresAt > Date.now())
  ) {
    return snapshot;
  }
  observedToken = token;
  snapshot = null;
  try {
    if (token) {
      const claims = jwtDecode<{ exp?: number }>(token);
      const platformId = authenticationSession.getPlatformId();
      const userId = authenticationSession.getCurrentUserId();
      if (
        claims.exp &&
        claims.exp * 1000 > Date.now() &&
        platformId &&
        userId
      ) {
        snapshot = Object.freeze({
          epoch: crypto.randomUUID(),
          platformId,
          userId,
          expiresAt: claims.exp * 1000,
        });
      }
    }
  } catch {
    /* Invalid credentials never expose cached billing data. */
  }
  return snapshot;
}
function subscribe(listener: () => void) {
  let expiryTimer: ReturnType<typeof setTimeout>;
  const notify = () => {
    clearTimeout(expiryTimer);
    const session = currentBillingSession();
    if (session)
      expiryTimer = setTimeout(
        notify,
        Math.min(
          2_147_483_647,
          Math.max(1, session.expiresAt - Date.now() + 1),
        ),
      );
    listener();
  };
  window.addEventListener('storage', notify);
  window.addEventListener('focus', notify);
  notify();
  return () => {
    clearTimeout(expiryTimer);
    window.removeEventListener('storage', notify);
    window.removeEventListener('focus', notify);
  };
}
export function useBillingSession() {
  return useSyncExternalStore(subscribe, currentBillingSession, () => null);
}
export function assertBillingSession(
  session: BillingSession | null,
): asserts session is BillingSession {
  if (!session || currentBillingSession() !== session)
    throw new BillingError('session');
}
export class BillingError extends Error {
  constructor(
    public readonly kind: 'session' | 'denied' | 'unavailable' | 'action',
  ) {
    super(`Hosted billing ${kind}`);
    this.name = 'BillingError';
  }
}
