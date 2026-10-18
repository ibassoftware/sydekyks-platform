import { useSyncExternalStore } from 'react';

import { authenticationSession } from '@/lib/authentication-session';

let previous = '';
let version = 0;
export function lmsSessionVersion() {
  let project: string | null = null;
  try {
    project = authenticationSession.getProjectId();
  } catch {
    /* Invalid tokens do not select a learning account. */
  }
  const next = JSON.stringify([authenticationSession.getToken(), project]);
  if (next !== previous) {
    previous = next;
    version += 1;
  }
  return version;
}
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener('pageshow', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('pageshow', listener);
  };
}
export function useLmsSession() {
  return useSyncExternalStore(subscribe, lmsSessionVersion, lmsSessionVersion);
}
