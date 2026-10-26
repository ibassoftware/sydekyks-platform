// @vitest-environment jsdom
import { act, ReactNode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreditAllowance } from './credit-allowance-api';
import { ClientCreditAllowanceSection } from './credit-allowance-section';
import { useHostedOperatorAccess } from './operator-api';

const mocks = vi.hoisted(() => ({
  state: null as unknown,
  save: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({
    setQueryData: mocks.setData,
    invalidateQueries: mocks.invalidate,
  }),
}));
vi.mock('./credit-allowance-api', () => ({
  useCreditAllowance: () => ({
    data: mocks.state,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  saveCreditAllowance: mocks.save,
  creditAllowanceKey: () => ['synthetic'],
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  assertAuthSession: vi.fn(),
}));
const session = {
  epoch: 'test-epoch',
  kind: 'user' as const,
  id: 'u'.repeat(21),
  platformId: 'p'.repeat(21),
  expiresAt: null,
};
const target = 't'.repeat(21);
const state = (): CreditAllowance => ({
  platformId: session.platformId,
  userId: session.id,
  scopePlatformId: target,
  revision: 1,
  planId: 'training',
  overrideMonthlyCredits: 10,
  defaultMonthlyCredits: 10000,
  effectiveMonthlyCredits: 10,
  appliesToCurrentPeriod: true,
  fixed: false,
  period: {
    validFrom: '2026-10-20T00:00:00.000Z',
    validUntil: '2026-11-20T00:00:00.000Z',
    amount: '10',
    consumed: '3',
    reserved: '2',
    available: '5',
  },
});
const access = { session, allowed: true } as ReturnType<
  typeof useHostedOperatorAccess
>;
let container: HTMLDivElement, root: Root;
const mount = (view: ReactNode) => root.render(view);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.state = state();
  mocks.save.mockReset();
  mocks.setData.mockReset();
  mocks.invalidate.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function mountAllowance() {
  await act(async () =>
    mount(
      <ClientCreditAllowanceSection
        access={access}
        platformId={target}
        clientName="Client example"
      />,
    ),
  );
}
async function input(
  node: HTMLInputElement | HTMLTextAreaElement,
  text: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(node, text);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent === label,
  )!;
describe('operator shared Credits editor', () => {
  it('shows one allowance with an operator cost estimate and requires a reason', async () => {
    await mountAllowance();
    expect(container).toMatchObject({
      textContent: expect.stringContaining('Monthly Credits allowance'),
    });
    expect(container).toMatchObject({
      textContent: expect.stringContaining('$0.015'),
    });
    expect(container).toMatchObject({
      textContent: expect.stringContaining(
        'does not increase the subscription price',
      ),
    });
    expect(container.querySelectorAll('input[type=number]')).toHaveLength(1);
    expect(container).not.toMatchObject({
      textContent: expect.stringContaining('AI credits per'),
    });
    expect(button('Save client allowance').disabled).toBe(true);
    await input(
      container.querySelector('textarea')!,
      'Agreed client allowance',
    );
    expect(button('Save client allowance').disabled).toBe(false);
  });
  it('blocks amounts below used plus held Credits and allows the exact committed floor', async () => {
    await mountAllowance();
    await input(
      container.querySelector('textarea')!,
      'Agreed client allowance',
    );
    const amount = container.querySelector(
      'input[type="number"]',
    )! as HTMLInputElement;
    await input(amount, '4');
    expect(container).toMatchObject({
      textContent: expect.stringContaining('below used and held Credits'),
    });
    expect(button('Save client allowance').disabled).toBe(true);
    await input(amount, '5');
    expect(button('Save client allowance').disabled).toBe(false);
    mocks.save.mockResolvedValue({
      ...state(),
      revision: 2,
      overrideMonthlyCredits: 5,
    });
    await act(async () => button('Save client allowance').click());
    expect(mocks.save.mock.calls[0].slice(1, 5)).toEqual([
      target,
      1,
      5,
      'Agreed client allowance',
    ]);
    expect(mocks.setData).toHaveBeenCalledOnce();
  });
  it('keeps trial and assessment grants fixed instead of rendering an override form', async () => {
    mocks.state = { ...state(), planId: 'trial', fixed: true };
    await mountAllowance();
    expect(container).toMatchObject({
      textContent: expect.stringContaining(
        'Trial and assessment allowances are fixed',
      ),
    });
    expect(container.querySelector('form')).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
