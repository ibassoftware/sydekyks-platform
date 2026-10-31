// Infrastructure is shared across hosted workspaces. Tenant admin is not enough.
export function canAccessPlatformInfrastructure({
  pathname,
  hosted,
  operatorAllowed,
}: {
  pathname: string;
  hosted: boolean;
  operatorAllowed: boolean;
}): boolean {
  if (!hosted || operatorAllowed) return true;
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  return !(
    path === '/platform/health' ||
    path === '/platform/infrastructure' ||
    path === '/platform/infrastructure/health' ||
    ['/platform/workers', '/platform/infrastructure/workers'].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}
