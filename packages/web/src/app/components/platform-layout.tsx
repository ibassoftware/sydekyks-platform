import { ApEdition, ApFlagId } from '@activepieces/shared';
import { t } from 'i18next';
import React, { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar-shadcn';
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
            <SidebarInset className="flex min-w-0 flex-col h-full overflow-hidden bg-gray-2">
              <PlatformMobileHeader />
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

function PlatformMobileHeader() {
  const { pathname } = useLocation();
  const { setOpenMobile, openMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-gray-6 px-3 py-2 md:hidden">
      <SidebarTrigger
        className="size-9"
        aria-label={t('Open platform navigation')}
        aria-expanded={openMobile}
      />
      <span className="text-sm font-medium">{t('Workspace navigation')}</span>
    </header>
  );
}

const PLATFORM_SIDEBAR_STYLE: React.CSSProperties & {
  '--sidebar-width': string;
} = {
  '--sidebar-width': '16rem',
};
