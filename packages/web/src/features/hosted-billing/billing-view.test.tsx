// @vitest-environment jsdom
import {
  HostedCustomerBillingOverview,
  hostingCatalog,
} from '@activepieces/shared';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedBillingView } from './billing-view';

vi.mock('i18next', () => ({
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) =>
      String(values?.[key] ?? key)
    ),
}));
vi.mock('@/components/custom/centered-page', () => ({
  CenteredPage: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </main>
  ),
}));
const meter = {
  state: 'active' as const,
  amount: '10000',
  consumed: '6',
  reserved: '12',
  available: '9982',
  validFrom: '2026-10-20T00:00:00.000Z',
  validUntil: '2026-11-20T00:00:00.000Z',
};
function overview(): HostedCustomerBillingOverview {
  return HostedCustomerBillingOverview.parse({
    schemaVersion: 1,
    platformId: 'p'.repeat(21),
    userId: 'u'.repeat(21),
    catalogVersion: hostingCatalog.version,
    serverTime: meter.validFrom,
    billingMode: 'manual',
    environment: 'manual',
    planId: 'starter',
    status: 'active',
    entitlementState: 'paid',
    validUntil: meter.validUntil,
    trialEndsAt: meter.validFrom,
    billingHold: false,
    subscriptionStatus: null,
    planChangesEnabled: false,
    notice: null,
    meters: { execution: meter },
    usage: {
      users: 2,
      projects: 1,
      pendingUsers: 0,
      pendingProjects: 0,
      activeExecutions: 0,
    },
    limits: hostingCatalog.getPlan({ planId: 'starter' }),
    plans: (['starter', 'team', 'scale'] as const).map((id) => ({
      id,
      limits: hostingCatalog.getPlan({ planId: id }),
      salesAssisted: hostingCatalog.paidPlans[id].salesAssisted,
      price: {
        amountMinor: hostingCatalog.paidPlans[id].amountMinor,
        currency: 'usd',
        interval: 'month',
      },
      checkout: { enabled: false, reason: 'manual_billing', continuing: false },
    })),
    portal: { enabled: false, reason: 'manual_billing', continuing: false },
  });
}
let element: HTMLDivElement, root: Root;
const checkout = vi.fn(),
  refresh = vi.fn(),
  portal = vi.fn();
beforeEach(() => {
  element = document.createElement('div');
  document.body.appendChild(element);
  root = createRoot(element);
  checkout.mockReset();
  refresh.mockReset();
  portal.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
async function render(info = overview(), stale = false) {
  await act(async () =>
    root.render(
      <HostedBillingView
        overview={info}
        stale={stale}
        refreshing={false}
        pending={null}
        actionError={false}
        checkoutReturn={null}
        onCheckout={checkout}
        onRefresh={refresh}
        onPortal={portal}
      />
    )
  );
}
describe('hosted commercial billing experience', () => {
  it('shows one Credit balance, held funds and all approved prices without a second AI allowance', async () => {
    await render();
    const text = element.textContent!;
    for (const value of [
      'Starter',
      'Growth',
      'Scale',
      '$99.00',
      '$399.00',
      '$1,299.00',
      '10 members',
      '30 members',
      '100 members',
      '100,000 Credits',
      '500,000 Credits',
      'Held',
      '9,982',
      'Enterprise',
    ])
      expect(text).toContain(value);
    expect(text).toContain('Sydekyks AI calls use additional Credits');
    expect(text).toContain('no additional managed-AI charge');
    expect(text).not.toContain('AI credits available');
    expect(text).not.toContain('AI allowance');
    expect(text).toContain('Core: $1,000 once');
    expect(text).toContain('Guided: $1,200 once');
    expect(text).toContain('12 months');
    expect(element.querySelectorAll('button')).toHaveLength(0);
  });
  it('offers test checkout only for eligible Starter/Growth and keeps Scale sales-assisted', async () => {
    const info = overview();
    info.billingMode = 'stripe_test';
    info.environment = 'test';
    for (const plan of info.plans)
      plan.checkout = { enabled: true, reason: null, continuing: false };
    await render(info);
    const buttons = Array.from(element.querySelectorAll('button'));
    const growth = buttons.find((button) =>
      button.textContent?.includes('Choose Growth')
    )!;
    expect(growth).toBeDefined();
    expect(
      buttons.some((button) => button.textContent?.includes('Choose Scale'))
    ).toBe(false);
    expect(element.textContent).toContain('capacity review');
    await act(async () => growth.click());
    expect(checkout).toHaveBeenCalledWith('team');
  });
  it('disables stale payment actions while preserving the last verified balance', async () => {
    const info = overview();
    info.billingMode = 'stripe_test';
    info.environment = 'test';
    for (const plan of info.plans) plan.checkout.enabled = true;
    await render(info, true);
    expect(element.textContent).toContain('last loaded balances');
    expect(element.textContent).toContain('9,982');
    const growth = Array.from(element.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Choose Growth')
    )!;
    expect(growth.disabled).toBe(true);
    await act(async () => growth.click());
    expect(checkout).not.toHaveBeenCalled();
  });
});
