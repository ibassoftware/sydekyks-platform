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

const state = vi.hoisted(() => ({ mobile: true, admin: true }));
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
function mount() {
  render(
    <MemoryRouter initialEntries={['/platform/projects']}>
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
});
describe('PlatformLayout mobile navigation consumer', () => {
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
    // Navigating to the already-selected route also dismisses the drawer.
    fireEvent.click(screen.getByRole('link', { name: 'Users' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('keeps the mobile header absent on desktop', () => {
    state.mobile = false;
    mount();
    expect(
      screen.queryByRole('button', { name: 'Open platform navigation' }),
    ).toBeNull();
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
