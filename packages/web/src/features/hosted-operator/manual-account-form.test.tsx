// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
afterEach(() => vi.useRealTimers());
function setup({ editExpiry = true } = {}) {
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
  if (editExpiry)
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
  it.each([
    ['2026-10-31T12:34:56Z', '2027-10-31T12:34'],
    ['2028-02-29T12:34:56Z', '2029-02-28T12:34'],
  ])(
    'prefills a calendar year from %s, including leap-day clamping',
    (now, expected) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      setup({ editExpiry: false });
      expect(
        screen.getByLabelText('Expiration / renewal due (UTC)'),
      ).toMatchObject({ value: expected });
    },
  );
  it('lets the server anchor automatic expiration to creation and keeps retries identical across dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:34:56Z'));
    const submit = setup({ editExpiry: false });
    fireEvent.click(
      screen.getByLabelText(/I verified the manual payment or authorization/),
    );
    mocks.create
      .mockRejectedValueOnce(new Error('Unknown network result'))
      .mockResolvedValueOnce({ account });
    fireEvent.click(submit);
    await screen.findByRole('alert');
    const first = mocks.create.mock.calls[0][1];
    expect(first.expiresAt).toBeUndefined();
    vi.setSystemTime(new Date('2026-11-01T12:34:56Z'));
    fireEvent.click(submit);
    await screen.findByText(/Account created:/);
    expect(mocks.create.mock.calls[1][1]).toEqual(first);
    expect(
      screen.getByLabelText('Expiration / renewal due (UTC)'),
    ).toMatchObject({ value: '2027-11-01T12:34' });
  });
  it('keeps client expiration as an explicit choice', () => {
    render(
      <MemoryRouter>
        <ManualAccountForm session={session} kind="client" />
      </MemoryRouter>,
    );
    expect(
      screen.getByLabelText('Expiration / renewal due (UTC)'),
    ).toMatchObject({ value: '' });
  });

  it('submits internal Starter with 35 Credits and prevents an above-cap submission', async () => {
    const submit = setup();
    fireEvent.change(screen.getByLabelText('Partner package'), {
      target: { value: 'starter' },
    });
    const credits = screen.getByLabelText(
      'Monthly Credits',
    ) as HTMLInputElement;
    expect(credits).toMatchObject({ value: '35', max: '35' });
    expect(screen.getByLabelText('Partner course')).toMatchObject({
      disabled: true,
    });
    fireEvent.click(
      screen.getByLabelText(/I verified the manual payment or authorization/),
    );
    fireEvent.change(credits, { target: { value: '35.01' } });
    fireEvent.click(submit);
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.change(credits, { target: { value: '35' } });
    mocks.create.mockResolvedValueOnce({
      account: { ...account, package: 'starter', monthlyCredits: 3500 },
    });
    fireEvent.click(submit);
    await screen.findByText(/Account created:/);
    expect(mocks.create.mock.calls[0][1]).toMatchObject({
      kind: 'partner',
      planId: 'training',
      monthlyCredits: 3500,
      partner: { package: 'starter', approve: false },
    });
    expect(mocks.create.mock.calls[0][1].partner.courseId).toBeUndefined();
  });
  it('restores the Core allowance when switching away from Starter', () => {
    setup();
    const packages = screen.getByLabelText('Partner package');
    fireEvent.change(packages, { target: { value: 'starter' } });
    fireEvent.change(packages, { target: { value: 'core' } });
    expect(screen.getByLabelText('Monthly Credits')).toMatchObject({
      value: '300',
    });
    expect(screen.getByLabelText('Partner course')).toMatchObject({
      disabled: false,
    });
  });

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
