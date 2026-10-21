// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedBillingPage } from './billing-page';

const mocks = vi.hoisted(() => ({
  access: { allowed: true, isPending: false, isError: false, refetch: vi.fn() },
  query: vi.fn(),
  refetch: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (text: string) => text }));
vi.mock('@/features/hosted-operator/operator-api', () => ({
  useHostedOperatorAccess: () => mocks.access,
}));
vi.mock('./billing-session', () => ({
  useBillingSession: () => ({
    epoch: 'session',
    platformId: 'platform',
    userId: 'user',
    platformRole: 'ADMIN',
  }),
  assertBillingSession: vi.fn(),
  BillingError: class extends Error {},
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.query,
  useQueryClient: () => ({
    cancelQueries: mocks.cancel,
    removeQueries: mocks.remove,
  }),
}));
vi.mock('./billing-api', () => ({ hostedBillingApi: {} }));
vi.mock('./billing-view', () => ({
  HostedBillingView: () => <p>Customer billing overview</p>,
}));
vi.mock('@/components/custom/centered-page', () => ({
  CenteredPage: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
let element: HTMLDivElement, root: Root;
const pageText = () => element.textContent ?? '';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.allowed = true;
  mocks.access.isPending = false;
  mocks.access.isError = false;
  mocks.query.mockReturnValue({
    data: {
      accountKind: 'client',
      serverTime: '2026-10-20T00:00:00.000Z',
      validUntil: '2026-11-20T00:00:00.000Z',
    },
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  });
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
        <HostedBillingPage />
      </MemoryRouter>,
    ),
  );
}
describe('hosted billing access routing', () => {
  it('opens service billing operations only after server-validated operator access, without loading customer trial data', async () => {
    await render();
    expect(pageText()).toContain('Client billing');
    expect(pageText()).toContain('Subscriptions & renewals');
    expect(pageText()).toContain('Managed AI controls');
    expect(
      element.querySelector('a[href="/platform/billing-operations"]'),
    ).not.toBeNull();
    expect(pageText()).not.toContain('trial');
    expect(pageText()).not.toContain('Customer billing overview');
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('does not treat a client platform ADMIN role as operator access', async () => {
    mocks.access.allowed = false;
    await render();
    expect(pageText()).toContain('Customer billing overview');
    expect(
      element.querySelector('a[href="/platform/billing-operations"]'),
    ).toBeNull();
    expect(mocks.query).toHaveBeenCalled();
  });
  it('waits for the server access check before showing a customer plan', async () => {
    mocks.access.allowed = false;
    mocks.access.isPending = true;
    await render();
    expect(pageText()).toContain('Checking billing access');
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('offers access-check recovery without showing an unverified customer plan', async () => {
    mocks.access.allowed = false;
    mocks.access.isError = true;
    await render();
    expect(pageText()).toContain('Billing access could not be checked');
    await act(async () => element.querySelector('button')!.click());
    expect(mocks.access.refetch).toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
