// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute, jest-dom/prefer-to-have-text-content -- No jest-dom runtime is installed. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secret: null as null | { identityId: string; otp: string },
  validate: vi.fn(),
  reset: vi.fn(),
  forget: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/api/authentication-api', () => ({
  authenticationApi: { validatePasswordReset: mocks.validate },
}));
vi.mock('@/lib/password-reset-secret', () => ({
  getPasswordResetSecret: () => mocks.secret,
  forgetPasswordResetSecret: mocks.forget,
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { clearSession: mocks.clear },
}));
vi.mock('@/features/authentication/hooks/auth-hooks', () => ({
  authMutations: {
    useResetPassword: (options: {
      onSuccess: () => void;
      onError: (error: unknown) => void;
    }) => ({
      isPending: false,
      mutate: (body: unknown) =>
        mocks.reset(body).then(options.onSuccess, options.onError),
    }),
  },
}));
import { ChangePasswordForm } from '@/features/authentication/components/change-password';

const secret = { identityId: 'i'.repeat(21), otp: 'synthetic-reset-code' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.secret = secret;
  mocks.validate.mockReset().mockResolvedValue({ valid: true });
  mocks.reset.mockReset().mockResolvedValue(undefined);
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChangePasswordForm />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function expectRecoveryLink() {
  expect(
    screen
      .getByRole('link', { name: 'Request a new reset email' })
      .getAttribute('href'),
  ).toBe('/forget-password');
  expect(screen.queryByLabelText('Password', { exact: true })).toBeNull();
}
it.each([null, { ...secret, otp: '' }, { ...secret, identityId: 'malformed' }])(
  'offers a new email without checking incomplete credentials: %s',
  (value) => {
    mocks.secret = value;
    setup();
    expect(screen.getByRole('alert').textContent).toContain(
      'missing, invalid or has expired',
    );
    expectRecoveryLink();
    expect(mocks.validate).not.toHaveBeenCalled();
  },
);
it('waits for server validation before asking for a new password', async () => {
  let resolve!: (value: { valid: boolean }) => void;
  mocks.validate.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  setup();
  expect(screen.getByRole('status').textContent).toContain(
    'check your password reset link',
  );
  expect(screen.queryByLabelText('Password', { exact: true })).toBeNull();
  await act(async () => resolve({ valid: true }));
  await screen.findByLabelText('Password', { exact: true });
  expect(mocks.validate).toHaveBeenCalledWith(secret);
});
it('replaces invalid or expired links with a clear recovery action', async () => {
  mocks.validate.mockResolvedValue({ valid: false });
  setup();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expectRecoveryLink();
});
it('offers a retry for connection failures instead of claiming the link is invalid', async () => {
  mocks.validate
    .mockRejectedValueOnce(new Error('Synthetic offline state'))
    .mockResolvedValueOnce({ valid: true });
  setup();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Check your connection',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByLabelText('Password', { exact: true });
});
it('shows the recovery action if the link expires after its initial check', async () => {
  mocks.reset.mockRejectedValue({ response: { status: 401 } });
  setup();
  fireEvent.change(await screen.findByLabelText('Password', { exact: true }), {
    target: { value: 'Synthetic-password-52!' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expectRecoveryLink();
  expect(mocks.forget).toHaveBeenCalled();
});
it('keeps the form available after a transient reset failure', async () => {
  mocks.reset.mockRejectedValue({ response: { status: 503 } });
  setup();
  fireEvent.change(await screen.findByLabelText('Password', { exact: true }), {
    target: { value: 'Synthetic-password-52!' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await screen.findByText('Could not reset your password. Try again shortly.');
  expect(screen.getByLabelText('Password', { exact: true })).toBeTruthy();
  expect(mocks.forget).not.toHaveBeenCalled();
});
