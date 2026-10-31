// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allowed: true,
  isPending: false,
  isError: false,
  clear: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (value: string) => value }));
vi.mock('@/components/custom/full-logo', () => ({
  FullLogo: () => <span>Sydekyks</span>,
}));
vi.mock(
  '@/features/authentication/components/auth-landing/turnstile-widget',
  () => ({ TurnstileWidget: () => null }),
);
vi.mock('@/features/hosted-operator/operator-api', () => ({
  useHostedOperatorAccess: () => ({
    allowed: mocks.allowed,
    isPending: mocks.isPending,
    isError: mocks.isError,
    refetch: mocks.refetch,
  }),
}));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: null }) },
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { clearSession: mocks.clear },
}));
vi.mock('./auth-session', () => ({
  useHostedAuthSession: () => ({
    kind: 'user',
    epoch: 'current',
    platformId: 'platform',
    id: 'user',
  }),
  assertAuthSession: vi.fn(),
  acceptHostedResponse: vi.fn(),
  HostedAuthError: class extends Error {},
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    cancelQueries: vi.fn(),
    removeQueries: vi.fn(),
    clear: mocks.clear,
  }),
  useQuery: () => ({
    isPending: false,
    isError: false,
    refetch: mocks.refetch,
  }),
}));
import { HostedAuthLanding } from './auth-landing';

let element: HTMLDivElement, root: Root;
const pageText = () => element.textContent;
beforeEach(() => {
  mocks.allowed = true;
  mocks.isPending = false;
  mocks.isError = false;
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
async function render() {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- ReactDOM root.render requires act; this is not Testing Library render.
  await act(async () =>
    root.render(
      <MemoryRouter>
        <HostedAuthLanding />
      </MemoryRouter>,
    ),
  );
}
describe('role-appropriate signed-in entry', () => {
  it('shows verified operators administration without personal trial offers', async () => {
    await render();
    expect(pageText()).toContain('Platform administration');
    expect(
      element.querySelector('a[href="/platform/partners"]'),
    ).not.toBeNull();
    expect(pageText()).not.toContain('Trial');
    expect(pageText()).not.toContain('Your workspace');
    expect(element.querySelector('a[href="/learn"]')).toBeNull();
  });
  it('does not infer global operator authority from an ordinary signed-in tenant admin', async () => {
    mocks.allowed = false;
    await render();
    expect(pageText()).toContain('Your workspace');
    expect(pageText()).not.toContain('Hosted pilot access');
    expect(pageText()).not.toContain('Trial duration');
    expect(element.querySelector('a[href="/platform/partners"]')).toBeNull();
  });
  it('waits for verified authority and offers recovery without flashing a customer trial', async () => {
    mocks.allowed = false;
    mocks.isPending = true;
    await render();
    expect(pageText()).toContain('Checking your access');
    expect(pageText()).not.toContain('Your workspace');
    mocks.isPending = false;
    mocks.isError = true;
    await render();
    expect(pageText()).toContain('Check access again');
    expect(element.querySelector('a[href="/platform/partners"]')).toBeNull();
  });
});
