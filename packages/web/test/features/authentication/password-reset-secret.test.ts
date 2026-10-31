// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(null, '', '/');
});
it('captures reset credentials before telemetry and removes them from the browser URL', async () => {
  window.history.replaceState(
    null,
    '',
    '/reset-password#otpcode=one-time-code&identityId=identity',
  );
  const secret = await import('@/lib/password-reset-secret');
  expect(window.location.hash).toBe('');
  expect(window.location.search).toBe('');
  expect(secret.getPasswordResetSecret()).toEqual({
    otp: 'one-time-code',
    identityId: 'identity',
  });
  expect(
    document.querySelector('meta[name="referrer"]')?.getAttribute('content'),
  ).toBe('no-referrer');
  secret.forgetPasswordResetSecret();
  expect(secret.getPasswordResetSecret()).toBeNull();
});
it('supports existing query links while removing their credential from the URL', async () => {
  window.history.replaceState(
    null,
    '',
    '/reset-password?otpcode=legacy-code&identityId=identity',
  );
  const secret = await import('@/lib/password-reset-secret');
  expect(window.location.search).toBe('');
  expect(secret.getPasswordResetSecret()?.otp).toBe('legacy-code');
});
it('does not capture or change unrelated page URLs', async () => {
  window.history.replaceState(null, '', '/agents?search=test#section');
  const secret = await import('@/lib/password-reset-secret');
  expect(secret.getPasswordResetSecret()).toBeNull();
  expect(window.location.search).toBe('?search=test');
});
