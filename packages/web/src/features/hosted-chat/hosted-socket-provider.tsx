import { ReactNode, useSyncExternalStore } from 'react';

import { SocketProvider } from '@/components/providers/socket-provider';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import { useHostedAuthSession } from '@/features/hosted-onboarding/auth-session';
import { authenticationSession } from '@/lib/authentication-session';

function subscribeProject(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener('focus', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('focus', listener);
  };
}
function currentProject() {
  try {
    return authenticationSession.getProjectId();
  } catch {
    return null;
  }
}
export function HostedSocketProvider({ children }: { children: ReactNode }) {
  const hosted = useHostedBillingEnabled();
  return hosted ? (
    <HostedSessionSocket>{children}</HostedSessionSocket>
  ) : (
    <SocketProvider>{children}</SocketProvider>
  );
}
function HostedSessionSocket({ children }: { children: ReactNode }) {
  const session = useHostedAuthSession();
  const projectId = useSyncExternalStore(
    subscribeProject,
    currentProject,
    () => null,
  );
  const token =
    session.kind === 'user' && projectId
      ? authenticationSession.getToken()
      : null;
  return (
    <SocketProvider session={{ token, projectId }}>{children}</SocketProvider>
  );
}
