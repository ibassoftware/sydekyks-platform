// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ kinds: [] as string[], allowed: true }));
vi.mock('i18next', () => ({
  t: (value: string, data?: Record<string, unknown>) =>
    value.replace(/\{(\w+)\}/g, (token, key) =>
      data?.[key] === undefined ? token : String(data[key])
    ),
}));
vi.mock('./operator-api', () => ({
  useHostedOperatorAccess: () => ({
    hosted: true,
    allowed: mocks.allowed,
    isPending: false,
    session: { kind: 'user', epoch: 'session' },
  }),
  operatorClientsQuery: (
    _session: unknown,
    _after: unknown,
    _allowed: boolean,
    kind: string
  ) => {
    mocks.kinds.push(kind);
    return {};
  },
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({
    data: {
      clients: [
        {
          platformId: 'c'.repeat(21),
          name: 'Moonlight Bakery',
          planId: 'team',
          status: 'active',
          validUntil: '2027-01-01',
          activeExecutions: 0,
          credits: {
            execution: {
              amount: '10000',
              consumed: '0',
              reserved: '0',
              available: '10000',
              scale: '1',
            },
          },
          modelCalls: { calls: '23', verifiedTokens: '5200', uncertain: '2' },
        },
      ],
      next: null,
    },
    refetch: vi.fn(),
  }),
}));
vi.mock('./manual-account-form', () => ({
  ManualAccountForm: () => <p>Create a client</p>,
}));
vi.mock('./managed-client-panel', () => ({
  ManagedClientPanel: ({ platformId }: { platformId: string }) => (
    <p>Persistent management for {platformId}</p>
  ),
}));
import { HostedClientsPage } from './clients-page';
let element: HTMLDivElement, root: Root;
const pageText = () => element.textContent ?? '';
beforeEach(() => {
  mocks.kinds = [];
  mocks.allowed = true;
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
describe('operator client list', () => {
  it('starts with client accounts and retains Manage client after page reload or revisiting a deep link', async () => {
    // eslint-disable-next-line testing-library/no-unnecessary-act -- ReactDOM root.render requires act; this is not Testing Library render.
    await act(async () =>
      root.render(
        <MemoryRouter
          initialEntries={[
            `/platform/billing/clients?client=${'c'.repeat(21)}`,
          ]}
        >
          <HostedClientsPage />
        </MemoryRouter>
      )
    );
    expect(mocks.kinds.at(-1)).toBe('client');
    expect(pageText()).toContain('Growth');
    expect(pageText()).toContain('23 recorded attempts');
    expect(pageText()).toContain('5,200 verified tokens');
    expect(pageText()).toContain('2 uncertain calls');
    expect(pageText()).toContain('100 available');
    expect(pageText()).toContain('Persistent management for');
    expect(
      element.querySelector(
        'button[aria-label="Manage client Moonlight Bakery"]'
      )
    ).not.toBeNull();
    const partners = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Partner hosting'
    )!;
    await act(async () => partners.click());
    expect(mocks.kinds.at(-1)).toBe('partner');
    expect(pageText()).not.toContain('Create a client');
    expect(pageText()).not.toContain('Persistent management for');
  });
  it('does not show management controls when operator authorization is absent', async () => {
    mocks.allowed = false;
    // eslint-disable-next-line testing-library/no-unnecessary-act -- ReactDOM root.render requires act; this is not Testing Library render.
    await act(async () =>
      root.render(
        <MemoryRouter>
          <HostedClientsPage />
        </MemoryRouter>
      )
    );
    expect(pageText()).toContain('configured service operators');
    expect(
      element.querySelector(
        'button[aria-label="Manage client Moonlight Bakery"]'
      )
    ).toBeNull();
  });
});
