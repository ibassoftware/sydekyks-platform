// @vitest-environment jsdom
// No jest-dom runtime is installed; check native DOM focus and attributes.
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-focus, jest-dom/prefer-to-have-attribute, testing-library/no-node-access */
import { ApEdition } from '@activepieces/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformLayout } from '@/app/components/platform-layout';
import { Sidebar } from '@/components/ui/sidebar-shadcn';

const state = vi.hoisted(() => ({
  mobile: true,
  admin: true,
  hosted: false,
  operator: false,
  pending: false,
}));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => state.hosted,
}));
vi.mock('@/features/hosted-operator/operator-api', () => ({
  useHostedOperatorAccess: () => ({
    allowed: state.operator,
    isPending: state.pending,
  }),
}));
vi.mock('@/features/hosted-operator/workspaces-api', () => ({
  useOperationalWorkspaces: () => ({ allowed: false }),
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => state.mobile }));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: ApEdition.COMMUNITY }) },
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useIsPlatformAdmin: () => state.admin,
}));
vi.mock('@/features/billing', () => ({ ManagePlanDialog: () => null }));
vi.mock('@/lib/release-availability', () => ({
  releaseAvailability: { isRouteAvailable: () => true },
}));
vi.mock('@/app/components/allow-logged-in-user-only-guard', () => ({
  AllowOnlyLoggedInUserOnlyGuard: ({
    children,
  }: {
    children: React.ReactNode;
  }) => children,
}));
vi.mock('@/app/components/global-search/global-search-context', () => ({
  GlobalSearchProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
// Keep the actual layout, provider, Sheet, and trigger; only replace the sidebar's
// server data dependencies with links so this exercises the production consumer.
vi.mock('@/app/components/sidebar/platform', () => ({
  PlatformSidebar: () => (
    <Sidebar>
      <Link to="/platform/users">Users</Link>
      <Link to="/">Back to app</Link>
    </Sidebar>
  ),
}));
function Location() {
  return <p>{useLocation().pathname}</p>;
}
function mount(path = '/platform/projects') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/platform/*"
          element={
            <PlatformLayout>
              <Location />
            </PlatformLayout>
          }
        />
        <Route path="/" element={<p>App home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  state.mobile = true;
  state.admin = true;
  state.hosted = false;
  state.operator = false;
  state.pending = false;
});
describe('PlatformLayout mobile navigation consumer', () => {
  it.each([
    '/platform/workers',
    '/platform/workers/groups',
    '/platform/health',
  ])('blocks direct hosted tenant access to %s', async (path) => {
    state.hosted = true;
    mount(path);
    await screen.findByText('/platform/health/runs');
    expect(screen.queryByText(path)).toBeNull();
  });
  it.each(['/platform/health/runs', '/platform/health/queue'])(
    'retains workspace health at %s',
    (path) => {
      state.hosted = true;
      mount(path);
      expect(screen.getByText(path)).toBeTruthy();
    },
  );
  it('does not mount protected content while operator access is loading', () => {
    state.hosted = true;
    state.pending = true;
    mount('/platform/workers');
    expect(screen.queryByText('/platform/workers')).toBeNull();
  });
  it('admits the authorized hosted operator to shared infrastructure', () => {
    state.hosted = true;
    state.operator = true;
    mount('/platform/workers');
    expect(screen.getByText('/platform/workers')).toBeTruthy();
  });

  it('exposes a real opener, closes with Escape, and returns keyboard focus', async () => {
    mount();
    const trigger = screen.getByRole('button', {
      name: 'Open platform navigation',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Back to app' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it('closes the drawer after a platform route changes and can reopen it', async () => {
    mount();
    const trigger = screen.getByRole('button', {
      name: 'Open platform navigation',
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('link', { name: 'Users' }));
    await screen.findByText('/platform/users');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    expect(screen.getByRole('link', { name: 'Users' })).toBeTruthy();
  });
  it('marks the mobile header hidden at the desktop breakpoint', () => {
    state.mobile = false;
    mount();
    expect(
      screen
        .getByRole('button', { name: 'Open platform navigation' })
        .closest('header')?.className,
    ).toContain('md:hidden');
    expect(screen.getByRole('link', { name: 'Back to app' })).toBeTruthy();
    expect(screen.getByText('/platform/projects')).toBeTruthy();
  });
  it('preserves the platform-admin gate without exposing mobile controls', async () => {
    state.admin = false;
    mount();
    await screen.findByText('App home');
    expect(
      screen.queryByRole('button', { name: 'Open platform navigation' }),
    ).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
