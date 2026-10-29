import { jwtDecode } from 'jwt-decode';
import { useSyncExternalStore } from 'react';

import { authenticationSession } from '@/lib/authentication-session';

export type ConversationSession = Readonly<{
  epoch: number;
  authenticated: boolean;
  expiresAt: number | null;
}>;
let token: string | null | undefined;
let snapshot: ConversationSession | undefined;
let epoch = 0;

// Cache keys use an opaque revision, never a bearer token. The token is only
// retained here to reject results from a request started before a session switch.
export function currentConversationSession(): ConversationSession {
  const currentToken = authenticationSession.getToken();
  const authenticated =
    currentToken !== null && !authenticationSession.isJwtExpired(currentToken);
  if (
    snapshot &&
    currentToken === token &&
    snapshot.authenticated === authenticated
  )
    return snapshot;
  token = currentToken;
  let expiresAt = null;
  if (authenticated && currentToken) {
    const { exp } = jwtDecode<{ exp?: number }>(currentToken);
    expiresAt = typeof exp === 'number' ? exp * 1000 : null;
  }
  snapshot = Object.freeze({ epoch: ++epoch, authenticated, expiresAt });
  return snapshot;
}

function subscribe(listener: () => void) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (!active) return;
    clearTimeout(timer);
    const session = currentConversationSession();
    if (session.authenticated && session.expiresAt)
      timer = setTimeout(
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
  window.addEventListener('pageshow', notify);
  notify();
  return () => {
    active = false;
    clearTimeout(timer);
    window.removeEventListener('storage', notify);
    window.removeEventListener('focus', notify);
    window.removeEventListener('pageshow', notify);
  };
}

export function useConversationSession() {
  return useSyncExternalStore(
    subscribe,
    currentConversationSession,
    currentConversationSession,
  );
}

export function assertConversationSession(session: ConversationSession) {
  if (!session.authenticated || currentConversationSession() !== session)
    throw new Error('The conversation session changed.');
}
