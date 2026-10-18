// This module must be the first import in main.tsx, before App, telemetry and
// error handlers are evaluated. The capability stays only in module memory.
let setupSecret: string | null = null;
if (
  typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/+$/, '') === '/partner-setup'
) {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token && /^[a-zA-Z0-9_-]{43}$/.test(token)) setupSecret = token;
  window.history.replaceState(null, '', window.location.pathname);
  const policy = document.createElement('meta');
  policy.name = 'referrer';
  policy.content = 'no-referrer';
  document.head.appendChild(policy);
}
export function getPartnerSetupSecret() {
  return setupSecret;
}
export function forgetPartnerSetupSecret() {
  setupSecret = null;
}
