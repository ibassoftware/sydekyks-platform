import { canAccessPlatformInfrastructure } from './platform-infrastructure-access';

// Product navigation may be deferred without changing route/API permissions.
export function canShowPlatformNavigation(options: {
  pathname: string;
  hosted: boolean;
  operatorAllowed: boolean;
}): boolean {
  if (!canAccessPlatformInfrastructure(options)) return false;
  if (!options.hosted || options.operatorAllowed) return true;
  const path = options.pathname
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .toLowerCase();
  return !(
    path === '/platform/configurations' ||
    path === '/platform/infrastructure/configurations' ||
    ['/platform/mcp', '/mcp-server'].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}
