import { tryCatchSync } from '@activepieces/core-utils';

function isAllowed({ url }: { url: string | null | undefined }): boolean {
  if (!url) return false;
  const { data: parsed, error } = tryCatchSync(
    () => new URL(url, 'http://localhost'),
  );
  if (error || !parsed) return false;
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'mailto:') {
    return !/@(?:[^@]*\.)?activepieces\.com$/i.test(parsed.pathname);
  }
  if (host === 'activepieces.com' || host.endsWith('.activepieces.com')) {
    return FUNCTIONAL_UPSTREAM_HOSTS.includes(host);
  }
  return !(
    host === 'github.com' && /^\/activepieces(?:\/|$)/i.test(parsed.pathname)
  );
}

export const publicLinkUtils = { isAllowed };

const FUNCTIONAL_UPSTREAM_HOSTS = [
  'cdn.activepieces.com',
  'secrets.activepieces.com',
  'cloud.activepieces.com',
  'api.activepieces.com',
];
