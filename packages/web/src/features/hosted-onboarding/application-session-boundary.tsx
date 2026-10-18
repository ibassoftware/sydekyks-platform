import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import { LoadingScreen } from '@/components/custom/loading-screen';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import { authenticationSession } from '@/lib/authentication-session';

import { currentAuthSession, subscribeHostedSession } from './auth-session';

function documentSession() {
  let project = null;
  try {
    project = authenticationSession.getProjectId();
  } catch {
    // A malformed credential is anonymous and cannot select a private project.
  }
  return JSON.stringify([
    authenticationSession.getToken(),
    project,
    currentAuthSession().kind,
  ]);
}

// Global collections own independent caches. A new document gives the next
// session fresh collections without racing their asynchronous cleanup.
export function HostedApplicationSessionBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  return useHostedBillingEnabled() ? (
    <HostedDocumentLifetime>{children}</HostedDocumentLifetime>
  ) : (
    children
  );
}

function HostedDocumentLifetime({ children }: { children: React.ReactNode }) {
  const current = useSyncExternalStore(
    subscribeHostedSession,
    documentSession,
    documentSession,
  );
  const initial = useRef(current);
  const reloading = useRef(false);
  const changed = current !== initial.current;
  useLayoutEffect(() => {
    const reload = () => {
      if (reloading.current) return;
      reloading.current = true;
      // Never carry another account's conversation/project URL into this session.
      window.location.replace(
        currentAuthSession().kind === 'anonymous' ? '/sign-in' : '/',
      );
    };
    if (changed) reload();
    const documentRoot = document.documentElement;
    const originalDisplay = documentRoot.style.display;
    // Portaled dialogs and menus live outside the React wrapper. Hide the whole
    // document before it can be retained in the back/forward cache.
    const hide = () => {
      documentRoot.style.display = 'none';
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted || documentSession() !== initial.current) reload();
      else documentRoot.style.display = originalDisplay;
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
    };
  }, [changed]);
  return changed ? <LoadingScreen /> : children;
}
