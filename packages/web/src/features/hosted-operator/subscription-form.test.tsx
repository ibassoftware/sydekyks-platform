// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperatorSubscription } from './subscription-api';
import { SubscriptionForm } from './subscription-page';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
  onSaved: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
  useQueryClient: () => ({
    setQueryData: mocks.setData,
    invalidateQueries: mocks.invalidate,
  }),
}));
vi.mock('./operator-api', () => ({
  operatorClientsQuery: vi.fn(),
  useHostedOperatorAccess: vi.fn(),
}));
vi.mock('./subscription-api', () => ({
  saveOperatorSubscription: mocks.save,
  subscriptionKey: () => ['synthetic'],
  SubscriptionUiError: class extends Error {},
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
function state(): OperatorSubscription {
  return {
    platformId: session.platformId,
    userId: session.id,
    scopePlatformId: 't'.repeat(21),
    name: 'Synthetic client',
    planId: 'training',
    accountStatus: 'active',
    billingHold: false,
    revision: 2,
    serverTime: '2026-10-19T00:00:00.000Z',
    renewalDueAt: '2026-11-01T00:00:00.000Z',
    graceEndsAt: '2026-11-16T00:00:00.000Z',
    state: 'review_required',
    origin: 'override',
    effectiveRuntimeUntil: '2026-11-16T00:00:00.000Z',
    canManage: false,
    limitation: 'entitlement_changed',
    boundPeriod: null,
  };
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.save.mockReset();
  mocks.onSaved.mockReset();
  mocks.invalidate.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(value = state()) {
  // React DOM createRoot requires act; this is not Testing Library render.
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () =>
    root.render(
      <SubscriptionForm
        state={value}
        session={session}
        onSaved={mocks.onSaved}
      />,
    ),
  );
}
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent === label,
  )!;
describe('operator subscription actions', () => {
  it('allows removing an existing override when new funding cannot be managed, with an audit reason', async () => {
    await render();
    expect(button('Save renewal date').disabled).toBe(true);
    expect(button('Reset date override').disabled).toBe(true);
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(textarea, 'Restore original funded window');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Reset date override').disabled).toBe(false);
    mocks.save.mockResolvedValue({
      ...state(),
      revision: 3,
      renewalDueAt: null,
      origin: 'fixed',
    });
    await act(async () => {
      button('Reset date override').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(mocks.save.mock.calls[0][3]).toMatchObject({
      renewalDueAt: null,
      expectedRevision: 2,
      reason: 'Restore original funded window',
    });
    expect(mocks.onSaved).toHaveBeenCalledOnce();
  });
  it('does not offer to remove the automatic paid-plan default', async () => {
    await render({
      ...state(),
      planId: 'starter',
      revision: 0,
      origin: 'paid_default',
      state: 'current',
      canManage: true,
    });
    expect(button('Reset date override')).toBeUndefined();
    // No jest-dom runtime is installed; use Vitest’s native rendered-text assertion.
    // eslint-disable-next-line jest-dom/prefer-to-have-text-content
    expect(container.textContent).toContain(
      'Automatic paid-plan renewal grace',
    );
  });
  it('shows suspension independently of a future grace cutoff', async () => {
    await render({ ...state(), accountStatus: 'suspended', billingHold: true });
    // No jest-dom runtime is installed; use Vitest’s native rendered-text assertion.
    // eslint-disable-next-line jest-dom/prefer-to-have-text-content
    expect(container.textContent).toContain(
      'A renewal date does not remove that restriction',
    );
  });
});
