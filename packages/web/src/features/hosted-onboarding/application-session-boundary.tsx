import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import { LoadingScreen } from '@/components/custom/loading-screen';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import { authenticationSession } from '@/lib/authentication-session';

import { currentAuthSession, subscribeHostedSession } from './auth-session';
import {
  HostedDocumentSession,
  hostedDocumentReloadPath,
} from './document-session-navigation';

function readDocumentSession(): HostedDocumentSession {
  let project = null;
  try {
    project = authenticationSession.getProjectId();
  } catch {
    // A malformed credential is anonymous and cannot select a private project.
  }
  const session = currentAuthSession();
  return {
    token: authenticationSession.getToken(),
    projectId: project,
    kind: session.kind,
    id: session.id,
    platformId: session.platformId,
  };
}

function documentSession() {
  return JSON.stringify(readDocumentSession());
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
  const initial = useRef({ key: current, session: readDocumentSession() });
  const reloading = useRef(false);
  const changed = current !== initial.current.key;
  useLayoutEffect(() => {
    const reload = () => {
      if (reloading.current) return;
      reloading.current = true;
      // Always reset document-owned caches. Only an unchanged account may keep
      // its selected project-list route; other session changes use a safe root.
      window.location.replace(
        hostedDocumentReloadPath(
          initial.current.session,
          readDocumentSession(),
          window.location,
        ),
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
      if (event.persisted || documentSession() !== initial.current.key)
        reload();
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
