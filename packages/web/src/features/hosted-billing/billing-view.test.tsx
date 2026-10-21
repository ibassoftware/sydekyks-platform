// @vitest-environment jsdom
import {
  HostedCustomerBillingOverview,
  hostingCatalog,
} from '@activepieces/shared';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedBillingView } from './billing-view';

const selection = vi.hoisted(() => ({ offer: null as string | null }));
vi.mock('./checkout-intent-review', () => ({
  useCheckoutIntent: () => ({
    intent: selection.offer ? { offer: selection.offer } : null,
  }),
  CheckoutIntentReview: () =>
    selection.offer ? <p>Incoming selection review</p> : null,
}));
vi.mock('./partner-purchase-section', () => ({
  PartnerPurchaseSection: ({
    selectedPackage,
    disabled,
  }: {
    selectedPackage: string;
    disabled: boolean;
  }) => <button disabled={disabled}>Review Partner {selectedPackage}</button>,
}));

vi.mock('i18next', () => ({
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) =>
      String(values?.[key] ?? key),
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
    accountKind: 'client',
    hostingEndsAt: '2026-11-18T00:00:00.000Z',
    renewalDueAt: '2026-11-18T00:00:00.000Z',
    nextCreditAllowanceAt: null,
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
const pageText = () => element.textContent ?? '';
const checkout = vi.fn(),
  refresh = vi.fn(),
  portal = vi.fn();
beforeEach(() => {
  element = document.createElement('div');
  document.body.appendChild(element);
  root = createRoot(element);
  selection.offer = null;
  checkout.mockReset();
  refresh.mockReset();
  portal.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
async function render(info = overview(), stale = false) {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- ReactDOM root.render requires act; this is not Testing Library render.
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
      />,
    ),
  );
}
describe('role-appropriate hosted billing', () => {
  it('shows a client’s current plan, seats and one Credit wallet without unrelated offers or supplier details', async () => {
    await render();
    const text = element.textContent!;
    for (const value of [
      'Starter',
      '$99.00',
      'Members',
      '2 of 10',
      'Available',
      'Used',
      'Held',
      '9,982',
      'Payments & invoices',
    ])
      expect(text).toContain(value);
    for (const value of [
      'Growth',
      'Scale',
      '$399.00',
      'Partner training packages',
      'Buy Core',
      'supplier cost',
      '2 Credits per',
      'DeepSeek',
      'AI allowance',
    ])
      expect(text).not.toContain(value);
    expect(text).toContain('Request payment instructions or an invoice');
    expect(text).toContain('No funded allowance scheduled');
    expect(element.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the Partner package and funded hosting term without a client plan catalog or duplicate purchase offers', async () => {
    const info = overview();
    info.accountKind = 'partner';
    info.planId = 'training';
    info.entitlementState = 'training';
    info.trainingPackage = 'launch';
    info.hostingEndsAt = '2027-10-20T00:00:00.000Z';
    info.renewalDueAt = null;
    info.nextCreditAllowanceAt = '2026-11-20T00:00:00.000Z';
    selection.offer = 'partner-core';
    await render(info);
    expect(pageText()).toContain('Partner Guided');
    expect(pageText()).toContain('2027');
    expect(pageText()).toContain('Arrange with Sydekyks');
    expect(pageText()).toContain('Next Credit allowance');
    expect(pageText()).not.toContain('Starter');
    expect(pageText()).not.toContain('Review Partner');
    expect(pageText()).not.toContain('Incoming selection review');
    expect(pageText()).not.toContain('Buy');
  });

  it('recognizes legacy training and assessment entitlements without relying on operational Partner approval', async () => {
    const info = overview();
    delete info.accountKind;
    info.planId = 'assessment';
    info.entitlementState = 'assessment';
    delete info.hostingEndsAt;
    delete info.renewalDueAt;
    await render(info);
    expect(pageText()).toContain('Partner assessment');
    expect(pageText()).toContain('Not recorded');
    expect(pageText()).not.toContain('Starter');
    expect(pageText()).not.toContain('Limited trial');
    expect(pageText()).not.toContain('Buy');
  });

  it('offers test checkout only for server-eligible plans and requires a current click', async () => {
    const info = overview();
    info.billingMode = 'stripe_test';
    info.environment = 'test';
    info.plans.find((plan) => plan.id === 'team')!.checkout = {
      enabled: true,
      reason: null,
      continuing: false,
    };
    await render(info);
    expect(checkout).not.toHaveBeenCalled();
    const buttons = Array.from(element.querySelectorAll('button'));
    const growth = buttons.find((button) =>
      button.textContent?.includes('Choose Growth'),
    )!;
    expect(growth).toBeDefined();
    expect(
      buttons.some((button) => button.textContent?.includes('Choose Starter')),
    ).toBe(false);
    expect(pageText()).not.toContain('$1,299.00');
    await act(async () => growth.click());
    expect(checkout).toHaveBeenCalledWith('team');
  });

  it('keeps explicit incoming Partner purchase review available for an unenrolled trial', async () => {
    const info = overview();
    info.accountKind = 'trial';
    info.planId = 'trial';
    info.entitlementState = 'trial';
    selection.offer = 'partner-guided';
    await render(info);
    expect(pageText()).toContain('Incoming selection review');
    expect(pageText()).toContain('Review Partner guided');
    expect(checkout).not.toHaveBeenCalled();
  });

  it('disables stale plan and Partner payment actions while preserving the last verified balance', async () => {
    const info = overview();
    info.billingMode = 'stripe_test';
    info.environment = 'test';
    info.planId = 'trial';
    info.accountKind = 'trial';
    selection.offer = 'partner-core';
    info.plans.find((plan) => plan.id === 'team')!.checkout.enabled = true;
    await render(info, true);
    expect(pageText()).toContain('last loaded balances');
    expect(pageText()).toContain('9,982');
    const buttons = Array.from(element.querySelectorAll('button'));
    const growth = buttons.find((button) =>
      button.textContent?.includes('Choose Growth'),
    )!;
    const partner = buttons.find((button) =>
      button.textContent?.includes('Review Partner'),
    )!;
    expect(growth.disabled).toBe(true);
    expect(partner.disabled).toBe(true);
    await act(async () => growth.click());
    expect(checkout).not.toHaveBeenCalled();
  });
});
