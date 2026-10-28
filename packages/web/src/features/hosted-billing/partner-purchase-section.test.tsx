// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PartnerPurchaseSection } from './partner-purchase-section';

const mocks = vi.hoisted(() => ({
  session: {
    epoch: 'synthetic-session',
    platformId: 'synthetic-platform',
    userId: 'synthetic-user',
    expiresAt: Date.now() + 86400_000,
  } as Record<string, unknown> | null,
  status: vi.fn(),
  checkout: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (value: string) => value }));
vi.mock('./billing-session', () => ({
  useBillingSession: () => mocks.session,
  currentBillingSession: () => mocks.session,
  BillingError: class extends Error {
    constructor(public kind: string) {
      super(kind);
    }
  },
}));
vi.mock('./partner-purchase-api', () => ({
  partnerPurchaseApi: { status: mocks.status, checkout: mocks.checkout },
}));
let root: Root, container: HTMLDivElement, client: QueryClient;
const pageText = () => container.textContent ?? '';
const status = () => ({
  platformId: 'synthetic-platform',
  userId: 'synthetic-user',
  billingMode: 'stripe_test',
  available: true,
  reason: null,
  purchase: null,
});
async function render(disabled = false) {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- ReactDOM root.render requires act; this is not Testing Library render.
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PartnerPurchaseSection selectedPackage="guided" disabled={disabled} />
      </QueryClientProvider>
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = {
    epoch: 'synthetic-session',
    platformId: 'synthetic-platform',
    userId: 'synthetic-user',
    expiresAt: Date.now() + 86400_000,
  };
  mocks.status.mockResolvedValue(status());
  mocks.checkout.mockResolvedValue(undefined);
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
describe('Partner purchase review', () => {
  it('preselects the reviewed package without starting a purchase and acts only on an explicit click', async () => {
    await render();
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(pageText()).toContain('Selected on the website');
    expect(pageText()).toContain('300 Credits');
    expect(pageText()).toContain('independent assessment');
    const buy = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Buy Guided')
    )!;
    expect(buy.disabled).toBe(false);
    await act(async () => {
      buy.click();
    });
    expect(mocks.checkout).toHaveBeenCalledWith(mocks.session, 'guided');
  });
  it('keeps manual payments explicit and disables online checkout', async () => {
    mocks.status.mockResolvedValue({
      ...status(),
      billingMode: 'manual',
      available: false,
      reason: 'manual',
    });
    await render();
    expect(pageText()).toContain('handled directly by Sydekyks');
    expect(pageText()).toContain('Arrange with Sydekyks');
    expect(pageText()).not.toContain('Buy Core');
    expect(pageText()).not.toContain('Buy Guided');
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('shows verified fulfilment and full-refund states without exposing provider identifiers', async () => {
    mocks.status.mockResolvedValue({
      ...status(),
      available: false,
      purchase: {
        package: 'core',
        state: 'refunded',
        accessUntil: null,
        refundedMinor: 100000,
      },
    });
    await render();
    expect(pageText()).toContain('Fully refunded');
    expect(pageText()).not.toContain('cus_');
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('removes purchase offers after verified enrollment', async () => {
    mocks.status.mockResolvedValue({
      ...status(),
      available: false,
      purchase: {
        package: 'core',
        state: 'fulfilled',
        accessUntil: '2027-10-20T00:00:00.000Z',
        refundedMinor: 0,
      },
    });
    await render();
    expect(pageText()).toContain('Purchase verified');
    expect(pageText()).not.toContain('Buy Core');
    expect(pageText()).not.toContain('Buy Guided');
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('pauses Partner checkout when the parent billing overview is stale', async () => {
    await render(true);
    const buy = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Buy Guided')
    )!;
    expect(buy.disabled).toBe(true);
    await act(async () => buy.click());
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('does not fetch or show purchase data after the session disappears', async () => {
    mocks.session = null;
    await render();
    expect(pageText()).toBe('');
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
