import { ApEdition, ApFlagId } from '@activepieces/shared';
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar-shadcn';
import { ManagePlanDialog } from '@/features/billing';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import { useIsPlatformAdmin } from '@/hooks/authorization-hooks';
import { flagsHooks } from '@/hooks/flags-hooks';
import { releaseAvailability } from '@/lib/release-availability';

import { AllowOnlyLoggedInUserOnlyGuard } from './allow-logged-in-user-only-guard';
import { GlobalSearchProvider } from './global-search/global-search-context';
import { PlatformSidebar } from './sidebar/platform';

export function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { data: edition } = flagsHooks.useFlag<ApEdition>(ApFlagId.EDITION);
  const hostedBilling = useHostedBillingEnabled();
  const { pathname } = useLocation();
  const showPlatformAdminDashboard = useIsPlatformAdmin();

  return (
    <AllowOnlyLoggedInUserOnlyGuard>
      <GlobalSearchProvider>
        {showPlatformAdminDashboard ? (
          <SidebarProvider open={true} style={PLATFORM_SIDEBAR_STYLE}>
            <PlatformSidebar />
            <SidebarInset className="flex flex-col h-full overflow-hidden bg-gray-2">
              <div className="flex-1 flex flex-col pr-2 pt-3 pb-3 overflow-hidden">
                <div
                  id="dashboard-content-container"
                  className="relative flex flex-col h-full bg-gray-1 rounded-xl shadow-panel border overflow-clip"
                >
                  <div className="flex flex-col flex-1 overflow-auto">
                    {releaseAvailability.isRouteAvailable({
                      pathname,
                      hostedBilling,
                    }) ? (
                      children
                    ) : (
                      <Navigate to="/platform/projects" replace />
                    )}
                  </div>
                </div>
              </div>
            </SidebarInset>
          </SidebarProvider>
        ) : (
          <Navigate to="/" />
        )}
        {edition !== ApEdition.COMMUNITY && <ManagePlanDialog />}
      </GlobalSearchProvider>
    </AllowOnlyLoggedInUserOnlyGuard>
  );
}

const PLATFORM_SIDEBAR_STYLE: React.CSSProperties & {
  '--sidebar-width': string;
} = {
  '--sidebar-width': '16rem',
};
