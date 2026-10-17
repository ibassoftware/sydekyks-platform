function isRouteAvailable({
  pathname,
  hostedBilling = false,
}: {
  pathname: string;
  hostedBilling?: boolean;
}): boolean {
  const path = pathname
    .split(/[?#]/)[0]
    .replace(/^\/projects\/[^/]+(?=\/)/, '');
  if (hostedBilling && path === '/platform/billing') return true;
  return !UNAVAILABLE_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export const releaseAvailability = {
  isRouteAvailable,
  teamProjects: true,
  projectAdministration: true,
  projectMembers: false,
  projectAlerts: false,
  projectProvisioning: false,
  projectLimits: false,
};

const UNAVAILABLE_ROUTE_PREFIXES = [
  '/platform/users/roles',
  '/platform/connections',
  '/platform/pieces/piece-sets',
  '/platform/templates',
  '/platform/ai/tiers',
  '/platform/sso',
  '/platform/secret-managers',
  '/platform/audit-log',
  '/platform/api-keys',
  '/platform/embedding',
  '/platform/workers/groups',
  '/platform/billing',
  '/platform/usage',
  '/impact',
  '/releases',
  '/approvals',
];
