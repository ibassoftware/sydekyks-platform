// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSettings } from './ai-settings-api';
import { ManagedAiSettingsPage } from './ai-settings-page';
import { HostedManagedAiEntry } from './managed-ai-entry';

const mocks = vi.hoisted(() => ({
  settings: null as AiSettings | null,
  clientSettings: null as AiSettings | null,
  access: {
    allowed: true,
    hosted: true,
    isPending: false,
    session: { epoch: 'session', kind: 'user' },
  },
  save: vi.fn(),
  approve: vi.fn(),
  observe: vi.fn(),
  invalidate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      clients: [{ platformId: 'client', name: 'Client workspace' }],
      next: null,
    },
    isFetching: false,
    refetch: mocks.refresh,
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock('./operator-api', () => ({
  useHostedOperatorAccess: () => mocks.access,
  operatorClientsQuery: vi.fn(),
}));
vi.mock('./ai-settings-api', () => ({
  useAiSettings: (_session: unknown, _allowed: boolean, target?: string) => ({
    data: target ? mocks.clientSettings : mocks.settings,
    isPending: false,
    isError: false,
    refetch: mocks.refresh,
  }),
  AiSettingsError: class extends Error {},
  saveAiSettings: mocks.save,
  approveAiPricing: mocks.approve,
  observeAiPricing: mocks.observe,
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  assertAuthSession: vi.fn(),
}));
vi.mock('./credit-allowance-section', () => ({
  ClientCreditAllowanceSection: ({ clientName }: { clientName: string }) => (
    <p>Credit allowance for {clientName}</p>
  ),
}));
function state(): AiSettings {
  const rate = { cacheHit: 1, cacheMiss: 2, output: 3 };
  const rates = { peak: rate, offPeak: rate, version: 'rate-version' };
  return {
    platformId: 'operator',
    userId: 'user',
    scopePlatformId: null,
    revision: 2,
    globalRevision: 2,
    mode: 'set',
    model: 'deepseek-flash',
    credential: {
      configured: true,
      scope: 'global',
      version: 'secret-version',
    },
    effective: {
      model: 'deepseek-flash',
      managedAvailable: false,
      reason: 'Diagnostic reason',
    },
    pricing: {
      status: 'needs_approval',
      revision: 1,
      observationId: 'observation',
      termsHash: 'terms-hash',
      observedAt: '2026-10-20T00:00:00.000Z',
      sourceValidUntil: '2099-12-31T00:00:00.000Z',
      sourceUrl: 'https://api-docs.deepseek.com/pricing',
      calendar: {
        version: 'calendar-version',
        from: '2026-10-20T00:00:00.000Z',
        until: '2099-12-31T00:00:00.000Z',
        source: 'official',
        schedule: 'Peak 00:00–12:00 UTC; off-peak 12:00–00:00 UTC',
      },
      terms: { models: { 'deepseek-flash': rates, 'deepseek-v4-pro': rates } },
      approval: null,
    },
  };
}
let element: HTMLDivElement, root: Root;
const pageText = () => element.textContent ?? '';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = state();
  mocks.clientSettings = {
    ...state(),
    scopePlatformId: 'client',
    mode: 'inherit',
  };
  mocks.access.allowed = true;
  mocks.approve.mockResolvedValue(undefined);
  mocks.invalidate.mockResolvedValue(undefined);
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
async function render(entry = false) {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- ReactDOM root.render requires act; this is not Testing Library render.
  await act(async () =>
    root.render(
      <MemoryRouter>
        {entry ? (
          <HostedManagedAiEntry access={mocks.access as never} />
        ) : (
          <ManagedAiSettingsPage />
        )}
      </MemoryRouter>,
    ),
  );
}
function approvalButton() {
  return [...element.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Approve observed pricing'),
  )!;
}
describe('Managed AI setup clarity', () => {
  it('shows saved configuration and next action, with approval expanded and metadata disclosed on demand', async () => {
    await render();
    expect(pageText()).toContain('DeepSeek Flash');
    expect(pageText()).toContain('Global key configured');
    expect(pageText()).toContain('Key and model saved. Review and approve');
    expect(element.querySelector('a[href="#managed-pricing"]')).not.toBeNull();
    expect(
      element
        .querySelector('#managed-pricing')!
        .parentElement!.querySelector('details')!.open,
    ).toBe(true);
    const metadata = [...element.querySelectorAll('details')].find((details) =>
      details
        .querySelector('summary')
        ?.textContent?.includes('Observation and calendar'),
    )!;
    expect(metadata.open).toBe(false);
    const configuration = [...element.querySelectorAll('details')].find(
      (details) =>
        details
          .querySelector('summary')
          ?.textContent?.includes('Configuration details'),
    )!;
    expect(configuration.open).toBe(false);
    expect(pageText()).not.toContain('Credit allowance for');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });
  it('shows the allowance panel only after selecting a client', async () => {
    await render();
    const select =
      element.querySelector<HTMLSelectElement>('#ai-settings-scope')!;
    await act(async () => {
      select.value = 'client';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(pageText()).toContain('Credit allowance for Client workspace');
    expect(pageText()).toContain('Inheriting the global default');
  });
  it('keeps valid observed pricing behind explicit confirmation and a current approval click', async () => {
    await render();
    expect(approvalButton().disabled).toBe(true);
    await act(async () =>
      element
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    expect(approvalButton().disabled).toBe(false);
    expect(mocks.approve).not.toHaveBeenCalled();
    await act(async () => approvalButton().click());
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.approve.mock.calls[0][2]).toBe('2099-12-31T00:00:00.000Z');
  });
  it('still blocks approval when the observed source has expired', async () => {
    mocks.settings!.pricing.sourceValidUntil = '2020-01-01T00:00:00.000Z';
    await render();
    await act(async () =>
      element
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    expect(approvalButton().disabled).toBe(true);
    await act(async () => approvalButton().click());
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('collapses a ready pricing review while leaving its approval status discoverable', async () => {
    mocks.settings!.effective.managedAvailable = true;
    mocks.settings!.pricing.status = 'ready';
    mocks.settings!.pricing.approval = {
      id: 'approval',
      validUntil: '2099-12-31T00:00:00.000Z',
      termsHash: 'terms-hash',
    };
    await render();
    expect(pageText()).toContain('Approved until');
    expect(
      element
        .querySelector('#managed-pricing')!
        .parentElement!.querySelector('details')!.open,
    ).toBe(false);
  });
  it('shows the saved model, key readiness and required pricing action in the compact entry', async () => {
    await render(true);
    expect(pageText()).toContain('DeepSeek Flash');
    expect(pageText()).toContain('Saved securely');
    expect(pageText()).toContain('Review and approve published pricing');
    expect(pageText()).not.toContain('Diagnostic reason');
    expect(
      element.querySelector('a[href="/platform/managed-ai"]'),
    ).not.toBeNull();
  });
});
