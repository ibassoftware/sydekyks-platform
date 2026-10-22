/** @vitest-environment jsdom */
/* eslint-disable jest-dom/prefer-in-document -- @testing-library/jest-dom is not a dependency of packages/web */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ selected: true }));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ clear: vi.fn() }),
}));
vi.mock('@/lib/checkout-intent', () => ({
  checkoutIntent: {
    billingPath: () => (state.selected ? '/platform/billing' : null),
  },
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  acceptHostedResponse: vi.fn(),
  assertAuthSession: vi.fn(),
}));
vi.mock('./workspaces-api', () => ({
  enterOperationalWorkspace: vi.fn(async () => ({
    platformId: 'client-workspace',
  })),
  useOperationalWorkspaces: () => ({
    session: { epoch: 'fixture', kind: 'user', platformId: 'partner-home' },
    hosted: true,
    isPending: false,
    isFetching: false,
    error: null,
    allowed: true,
    data: {
      workspaces: [{ platformId: 'client-workspace', name: 'Sandbox client' }],
    },
    refetch: vi.fn(),
  }),
}));

import { enterOperationalWorkspace } from './workspaces-api';
import { PartnerWorkspacesPage } from './workspaces-page';

function Destination() {
  return <p>{useLocation().pathname}</p>;
}
function openPicker() {
  return render(
    <MemoryRouter initialEntries={['/platform/workspaces']}>
      <Routes>
        <Route
          path="/platform/workspaces"
          element={<PartnerWorkspacesPage />}
        />
        <Route path="*" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  state.selected = true;
  vi.clearAllMocks();
});

describe('safe workspace entry destination', () => {
  it('does not enter a workspace on GET and opens the workspace after explicit selection', async () => {
    openPicker();
    expect(enterOperationalWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open {name}' }));
    await screen.findByText('/');
    expect(enterOperationalWorkspace).toHaveBeenCalledOnce();
  });
  it('keeps the existing home destination after the offer is cleared', async () => {
    state.selected = false;
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Open {name}' }));
    expect(await screen.findByText('/')).toBeTruthy();
  });
});
