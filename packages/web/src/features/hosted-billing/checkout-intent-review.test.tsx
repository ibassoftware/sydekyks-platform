/** @vitest-environment jsdom */
/* eslint-disable jest-dom/prefer-in-document -- @testing-library/jest-dom is not a dependency of packages/web */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ selected: true }));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/components/providers/embed-provider', () => ({
  useEmbedding: () => ({ embedState: { isEmbedded: false } }),
}));
vi.mock('@/lib/checkout-intent', () => ({
  CHECKOUT_INTENT_EVENT: 'checkout-fixture',
  checkoutIntent: {
    read: () =>
      state.selected ? { offer: 'growth', createdAt: 100_000 } : null,
    billingPath: () => (state.selected ? '/platform/billing' : null),
    clear: () => {
      state.selected = false;
      window.dispatchEvent(new Event('checkout-fixture'));
    },
  },
}));

import { useRedirectAfterLogin } from '@/lib/navigation-utils';

import { CheckoutIntentReview } from './checkout-intent-review';

function FinishSignIn() {
  const redirect = useRedirectAfterLogin();
  return <button onClick={redirect}>Finish sign in</button>;
}
function Destination() {
  return <p>{useLocation().pathname}</p>;
}
beforeEach(() => {
  state.selected = true;
});

describe('checkout intent review', () => {
  it('shows the selected price and allows clearing it without starting payment', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    try {
      render(<CheckoutIntentReview />);
      expect(screen.getByText('$399 USD / month')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: /confirm checkout/i }),
      ).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
      await waitFor(() =>
        expect(screen.queryByText('$399 USD / month')).toBeNull(),
      );
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([true, false])(
    'resumes billing only while a selection remains (%s)',
    async (selected) => {
      state.selected = selected;
      render(
        <MemoryRouter initialEntries={['/sign-in?from=%2Fplatform%2Fprojects']}>
          <Routes>
            <Route path="/sign-in" element={<FinishSignIn />} />
            <Route path="*" element={<Destination />} />
          </Routes>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Finish sign in' }));
      expect(
        await screen.findByText(
          selected ? '/platform/billing' : '/platform/projects',
        ),
      ).toBeTruthy();
    },
  );
});
