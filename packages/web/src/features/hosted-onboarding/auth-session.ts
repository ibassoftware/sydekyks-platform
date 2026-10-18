import { AuthenticationResponse, PrincipalType } from '@activepieces/shared';
import { jwtDecode } from 'jwt-decode';
import { useSyncExternalStore } from 'react';

import { authenticationSession } from '@/lib/authentication-session';

type Session = Readonly<{
  epoch: string;
  kind: 'anonymous' | 'onboarding' | 'user';
  id: string | null;
  platformId: string | null;
  expiresAt: number | null;
}>;
let token: string | null | undefined;
let snapshot: Session;
export function currentAuthSession(): Session {
  const value = authenticationSession.getToken();
  if (
    value === token &&
    snapshot &&
    (!snapshot.expiresAt || snapshot.expiresAt > Date.now())
  )
    return snapshot;
  token = value;
  let kind: Session['kind'] = 'anonymous',
    id = null,
    platformId = null,
    expiresAt = null;
  try {
    if (value) {
      const claims = jwtDecode<{
        type: string;
        id: string;
        exp: number;
        platform?: { id: string };
      }>(value);
      if (claims.exp * 1000 > Date.now() && typeof claims.id === 'string') {
        kind =
          claims.type === PrincipalType.ONBOARDING
            ? 'onboarding'
            : claims.type === PrincipalType.USER && claims.platform?.id
            ? 'user'
            : 'anonymous';
        if (kind !== 'anonymous') {
          id = claims.id;
          platformId = claims.platform?.id ?? null;
          expiresAt = claims.exp * 1000;
        }
      }
    }
  } catch {
    /* Malformed credentials cannot resume onboarding. */
  }
  snapshot = Object.freeze({
    epoch: crypto.randomUUID(),
    kind,
    id,
    platformId,
    expiresAt,
  });
  return snapshot;
}
export function subscribeHostedSession(listener: () => void) {
  let active = true;
  let pending = false;
  let timer: ReturnType<typeof setTimeout>;
  const notify = () => {
    pending = false;
    if (!active) return;
    clearTimeout(timer);
    const session = currentAuthSession();
    if (session.expiresAt)
      timer = setTimeout(
        notify,
        Math.min(
          2_147_483_647,
          Math.max(1, session.expiresAt - Date.now() + 1),
        ),
      );
    listener();
  };
  // A verified response clears then replaces storage synchronously. Observe its final state.
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(notify);
  };
  window.addEventListener('storage', schedule);
  window.addEventListener('focus', schedule);
  window.addEventListener('pageshow', schedule);
  notify();
  return () => {
    active = false;
    clearTimeout(timer);
    window.removeEventListener('storage', schedule);
    window.removeEventListener('focus', schedule);
    window.removeEventListener('pageshow', schedule);
  };
}
export function useHostedAuthSession() {
  return useSyncExternalStore(
    subscribeHostedSession,
    currentAuthSession,
    currentAuthSession,
  );
}
export function assertAuthSession(session: Session) {
  if (currentAuthSession() !== session) throw new HostedAuthError('session');
}
export function acceptHostedResponse(
  response: AuthenticationResponse,
  session: Session,
  resetCache: () => void,
) {
  assertAuthSession(session);
  if (!response.verified) throw new HostedAuthError('verification');
  let claims;
  try {
    claims = jwtDecode<{
      id: string;
      type: string;
      exp: number;
      platform?: { id: string };
    }>(response.token);
  } catch {
    throw new HostedAuthError('unavailable');
  }
  const onboarding =
    claims.type === PrincipalType.ONBOARDING &&
    response.platformId === null &&
    response.projectId === null;
  const user =
    claims.type === PrincipalType.USER &&
    !!response.platformId &&
    claims.platform?.id === response.platformId;
  if (
    (!onboarding && !user) ||
    claims.id !== response.id ||
    !(claims.exp * 1000 > Date.now())
  )
    throw new HostedAuthError('unavailable');
  // Clear stale project pointers before a verified onboarding/null-project response.
  resetCache();
  authenticationSession.clearSession();
  authenticationSession.saveResponse(response, false);
}
export class HostedAuthError extends Error {
  constructor(
    public readonly kind:
      | 'session'
      | 'verification'
      | 'credentials'
      | 'code'
      | 'rate'
      | 'captcha'
      | 'unavailable'
      | 'trial'
      | 'approval'
      | 'denied',
  ) {
    super(`Hosted authentication ${kind}`);
    this.name = 'HostedAuthError';
  }
}
