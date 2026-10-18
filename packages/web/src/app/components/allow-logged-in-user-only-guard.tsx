import { Navigate, useLocation } from 'react-router-dom';

import { AutomaticTrialActivation } from '@/features/billing';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import { HostedSocketProvider as SocketProvider } from '@/features/hosted-chat/hosted-socket-provider';
import { useHostedAuthSession } from '@/features/hosted-onboarding/auth-session';
import { projectCollectionUtils } from '@/features/projects';
import { flagsHooks } from '@/hooks/flags-hooks';
import { platformHooks } from '@/hooks/platform-hooks';

import { authenticationSession } from '../../lib/authentication-session';

type AllowOnlyLoggedInUserOnlyGuardProps = {
  children: React.ReactNode;
};
export const AllowOnlyLoggedInUserOnlyGuard = ({
  children,
}: AllowOnlyLoggedInUserOnlyGuardProps) => {
  return useHostedBillingEnabled() ? (
    <HostedGuard>{children}</HostedGuard>
  ) : (
    <LegacyGuard>{children}</LegacyGuard>
  );
};

function HostedGuard({ children }: AllowOnlyLoggedInUserOnlyGuardProps) {
  const session = useHostedAuthSession();
  if (session.kind === 'anonymous') return <Navigate to="/sign-in" replace />;
  if (session.kind === 'onboarding')
    return <Navigate to="/create-platform" replace />;
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}

function LegacyGuard({ children }: AllowOnlyLoggedInUserOnlyGuardProps) {
  const location = useLocation();
  if (!authenticationSession.isLoggedIn()) {
    authenticationSession.logOut();
    const searchParams = new URLSearchParams();
    searchParams.set('from', location.pathname + location.search);
    return <Navigate to={`/sign-in?${searchParams.toString()}`} replace />;
  }
  if (authenticationSession.isOnboarding()) {
    return <Navigate to="/create-platform" replace />;
  }
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}

function AuthenticatedShell({ children }: AllowOnlyLoggedInUserOnlyGuardProps) {
  platformHooks.useCurrentPlatform();
  flagsHooks.useFlags();
  projectCollectionUtils.useCurrentProject();
  return (
    <SocketProvider>
      <AutomaticTrialActivation />
      {children}
    </SocketProvider>
  );
}
