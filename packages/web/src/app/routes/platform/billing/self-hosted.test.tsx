// @vitest-environment jsdom
import React, { act, ReactNode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useFlag, hostedOverview } = vi.hoisted(() => ({
  useFlag: vi.fn(),
  hostedOverview: vi.fn(),
}));
vi.mock('@/hooks/flags-hooks', () => ({ flagsHooks: { useFlag } }));
vi.mock('@/features/hosted-billing/billing-page', () => ({
  HostedBillingPage: () => {
    hostedOverview();
    return <button>Choose hosted paid plan</button>;
  },
}));
vi.mock('@/app/components/billing-page-shell', () => ({
  BillingPageShell: () => <main>Installation billing settings</main>,
}));
vi.mock('@/features/billing', () => ({
  CurrentSubscriptionCard: vi.fn(),
  CreditsCard: vi.fn(),
  CreditsInfoDialog: vi.fn(),
  AutoRechargeCard: vi.fn(),
  CancelSubscriptionDialog: vi.fn(),
  KeepPlanDialog: vi.fn(),
  planSelectorUtils: {},
  LicenseKey: vi.fn(),
  UsersCard: vi.fn(),
  billingMutations: {},
  billingUtils: {},
  useCancelSubscriptionGuard: vi.fn(),
  useManagePlanDialogStore: vi.fn(),
}));
vi.mock('@/hooks/platform-hooks', () => ({ platformHooks: {} }));
vi.mock('./usage-tab', () => ({ UsageTab: vi.fn() }));
vi.mock('i18next', () => ({ t: (value: string) => value }));

import { BillingPlanTab } from './index';

let element: HTMLDivElement, root: Root;
const mount = (view: ReactNode) => root.render(view);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useFlag.mockReset();
  hostedOverview.mockReset();
  element = document.createElement('div');
  document.body.appendChild(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});

describe('billing route requires explicit hosted opt-in', () => {
  it.each([undefined, 'self_hosted'])(
    'does not mount hosted billing or initiate its overview in mode %s',
    async (mode) => {
      useFlag.mockReturnValue({ data: mode });
      await act(async () => mount(<BillingPlanTab />));
      expect(element).toMatchObject({
        textContent: 'Installation billing settings',
      });
      expect(element.querySelector('button')).toBeNull();
      expect(hostedOverview).not.toHaveBeenCalled();
    },
  );

  it('mounts hosted billing only for the hosted flag', async () => {
    useFlag.mockReturnValue({ data: 'hosted' });
    await act(async () => mount(<BillingPlanTab />));
    expect(element).toMatchObject({ textContent: 'Choose hosted paid plan' });
    expect(hostedOverview).toHaveBeenCalledOnce();
  });
});
