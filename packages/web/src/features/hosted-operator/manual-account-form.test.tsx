// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), onCreated: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [], isError: false, refetch: vi.fn() }),
}));
vi.mock('./manual-accounts-api', () => ({
  createManualAccount: mocks.create,
  readManualPartnerCourses: vi.fn(),
  ManualAccountError: class extends Error {},
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
import { ManualAccountForm } from './manual-account-form';
const session = {
  epoch: 'manual-form-session',
  kind: 'user' as const,
  id: 'u'.repeat(21),
  platformId: 'p'.repeat(21),
  expiresAt: null,
};
const account = {
  identityId: 'i'.repeat(21),
  platformId: 'a'.repeat(21),
  name: 'Sample company',
  email: 'person@example.invalid',
  kind: 'partner' as const,
  planId: 'training' as const,
  termId: 't'.repeat(21),
  revision: 1,
  startsAt: '2026-10-21T00:00:00.000Z',
  expiresAt: '2027-01-01T00:00:00.000Z',
  graceEndsAt: '2027-01-16T00:00:00.000Z',
  monthlyCredits: 10_000,
  seats: 1,
  enrollmentId: null,
};
beforeEach(() => {
  mocks.create.mockReset();
  mocks.onCreated.mockReset();
});
function setup() {
  render(
    <MemoryRouter>
      <ManualAccountForm
        session={session}
        kind="partner"
        onCreated={mocks.onCreated}
      />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Company / workspace name'), {
    target: { value: account.name },
  });
  fireEvent.change(screen.getByLabelText('Full name'), {
    target: { value: 'Example Person' },
  });
  fireEvent.change(screen.getByLabelText('Email', { exact: true }), {
    target: { value: account.email },
  });
  fireEvent.change(screen.getByLabelText('Initial password'), {
    target: { value: 'Synthetic-only-initial-password' },
  });
  fireEvent.change(screen.getByLabelText('Expiration / renewal due (UTC)'), {
    target: { value: '2027-01-01T00:00' },
  });
  fireEvent.change(
    screen.getByLabelText('Manual payment reference / authorization reason'),
    { target: { value: 'Fictional test funding authorization' } },
  );
  return screen.getByRole('button', {
    name: 'Create Partner account',
  }) as HTMLButtonElement;
}
describe('manual creation funding and retry controls', () => {
  it('requires deliberate funding confirmation and leaves Partner operational approval unchecked', () => {
    const submit = setup();
    expect(submit.disabled).toBe(true);
    const approve = screen.getByLabelText(
      /Approve operational Partner access now/,
    ) as HTMLInputElement;
    expect(approve).toMatchObject({ checked: false });
    fireEvent.click(
      screen.getByLabelText(/I verified the manual payment or authorization/),
    );
    expect(submit.disabled).toBe(false);
  });
  it('reuses the request key after an unknown result and clears the password only after confirmation', async () => {
    const submit = setup();
    fireEvent.click(
      screen.getByLabelText(/I verified the manual payment or authorization/),
    );
    mocks.create
      .mockRejectedValueOnce(new Error('Unknown network result'))
      .mockResolvedValueOnce({ account });
    fireEvent.click(submit);
    await screen.findByRole('alert');
    expect(
      (screen.getByLabelText('Initial password') as HTMLInputElement).value,
    ).toBe('Synthetic-only-initial-password');
    fireEvent.click(submit);
    await screen.findByText(/Account created:/);
    const first = mocks.create.mock.calls[0][1],
      second = mocks.create.mock.calls[1][1];
    expect(second.requestKey).toBe(first.requestKey);
    expect(first).toMatchObject({
      kind: 'partner',
      planId: 'training',
      monthlyCredits: 30000,
      partner: { package: 'core', approve: false },
      expiresAt: account.expiresAt,
    });
    expect(
      (screen.getByLabelText('Initial password') as HTMLInputElement).value,
    ).toBe('');
    expect(mocks.onCreated).toHaveBeenCalledOnce();
    expect(
      screen.queryAllByText('Synthetic-only-initial-password'),
    ).toHaveLength(0);
  });
});
