// Capture recovery credentials before telemetry or the router starts.
let passwordResetSecret: { otp: string; identityId: string } | null = null;
if (
  typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/+$/, '').toLowerCase() ===
    '/reset-password'
) {
  const params = new URLSearchParams(
    window.location.hash.slice(1) || window.location.search,
  );
  passwordResetSecret = {
    otp: params.get('otpcode') ?? '',
    identityId: params.get('identityId') ?? '',
  };
  window.history.replaceState(null, '', window.location.pathname);
  const policy = document.createElement('meta');
  policy.name = 'referrer';
  policy.content = 'no-referrer';
  document.head.appendChild(policy);
}
export function getPasswordResetSecret() {
  return passwordResetSecret;
}
export function forgetPasswordResetSecret() {
  passwordResetSecret = null;
}
