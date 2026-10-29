/** @vitest-environment jsdom */
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute -- No jest-dom runtime is installed. */
import { ApEdition } from '@activepieces/shared';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformSidebar } from '@/app/components/sidebar/platform';
import { SidebarProvider } from '@/components/ui/sidebar-shadcn';

const state = vi.hoisted(() => ({
  plan: { aiProvidersEnabled: false, chatEnabled: true },
  edition: 'ce',
  unavailable: [] as string[],
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
// This fixture exercises self-hosted navigation. Hosted permission/transport
// hooks stay disabled rather than starting unrelated API queries while rendering.
vi.mock('@/app/components/project-settings/mcp-server/utils/mcp-hooks', () => ({
  mcpHooks: { useMcpReach: () => ({ reachesMcp: false }) },
}));
vi.mock('@/features/hosted-operator/operator-api', () => ({
  useHostedOperatorAccess: () => ({ allowed: false }),
}));
vi.mock('@/features/hosted-operator/trainers-api', () => ({
  usePlatformTrainerAccess: () => ({ allowed: false }),
}));
vi.mock('@/features/hosted-operator/workspaces-api', () => ({
  useOperationalWorkspaces: () => ({ allowed: false }),
}));
vi.mock('@/hooks/platform-hooks', () => ({
  platformHooks: {
    useCurrentPlatform: () => ({ platform: { plan: state.plan } }),
  },
}));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: state.edition }) },
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({ checkAccess: () => true }),
}));
vi.mock('@/components/providers/telemetry-provider', () => ({
  useTelemetry: () => ({ capture: vi.fn() }),
}));
vi.mock('@/lib/route-utils', () => ({ determineDefaultRoute: () => '/chat' }));
vi.mock('@/lib/release-availability', () => ({
  releaseAvailability: {
    isRouteAvailable: ({ pathname }: { pathname: string }) =>
      !state.unavailable.includes(pathname),
  },
}));
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
vi.mock('@/app/components/sidebar/sidebar-user', () => ({
  SidebarUser: () => null,
}));
// Billing services are unrelated to rendering this self-hosted navigation. Keep
// only the existing feature tier labels used by the real sidebar item component.
vi.mock('@/features/billing', () => ({
  PLATFORM_FEATURES: Object.fromEntries(
    [
      'projectRoles',
      'globalConnections',
      'pieces',
      'templates',
      'aiProviders',
      'sso',
      'secretManagers',
      'auditLogs',
      'eventStreaming',
      'apiKeys',
      'embedding',
    ].map((key) => [key, { tier: 'enterprise' }]),
  ),
  TIER_LABELS: { enterprise: 'Enterprise' },
}));
function renderSidebar() {
  render(
    <MemoryRouter initialEntries={['/platform/ai']}>
      <SidebarProvider open>
        <PlatformSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  state.plan.aiProvidersEnabled = false;
  state.edition = ApEdition.COMMUNITY;
  state.unavailable = [];
});
describe('current self-hosted PlatformSidebar', () => {
  it('leaves AI navigation unmarked when the existing capability is enabled', () => {
    state.plan.aiProvidersEnabled = true;
    renderSidebar();
    expect(
      screen.getByRole('link', { name: 'AI Center' }).getAttribute('href'),
    ).toBe('/platform/ai');
    expect(
      screen.getByRole('link', { name: 'Providers' }).getAttribute('href'),
    ).toBe('/platform/ai');
    expect(
      screen.getByRole('link', { name: 'Capabilities' }).getAttribute('href'),
    ).toBe('/platform/ai/capabilities');
  });
  it('presents the inherited plan restriction without pretending a link is server authorization', () => {
    renderSidebar();
    expect(
      screen.getByRole('link', { name: 'AI Center Requires a plan upgrade' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Providers' }).getAttribute('href'),
    ).toBe('/platform/ai');
  });
  it('omits unavailable routes and their children from the actual menu', () => {
    state.unavailable = ['/platform/ai'];
    renderSidebar();
    expect(screen.queryByRole('link', { name: /AI Center/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Providers' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
  });
  it('keeps Community billing marked and the authorized return route reachable', () => {
    renderSidebar();
    expect(
      screen.getByRole('link', {
        name: 'Billing & subscription Requires a plan upgrade',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Back to app' }).getAttribute('href'),
    ).toBe('/chat');
    expect(screen.getByRole('link', { name: 'Configurations' })).toBeTruthy();
  });
  it('does not add the self-hosted configuration entry to cloud edition', () => {
    state.edition = ApEdition.CLOUD;
    renderSidebar();
    expect(screen.queryByRole('link', { name: 'Configurations' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Billing & subscription' }),
    ).toBeTruthy();
  });

  it.each([ApEdition.CLOUD, ApEdition.ENTERPRISE])(
    'omits unavailable legacy model tiers on %s',
    (edition) => {
      state.plan.aiProvidersEnabled = true;
      state.edition = edition;
      renderSidebar();
      expect(screen.queryByRole('link', { name: 'Tiers' })).toBeNull();
    },
  );
});
