import { describe, expect, it } from 'vitest';

import { STATIC_PAGES } from '@/app/components/global-search/static-pages';
import { releaseAvailability } from '@/lib/release-availability';

describe('public release navigation', () => {
  it.each([
    '/platform/templates', '/platform/ai/tiers', '/platform/sso', '/platform/users/roles',
    '/platform/connections', '/platform/connections/global', '/platform/secret-managers',
    '/platform/audit-log', '/platform/audit-log/streaming/new',
    '/platform/api-keys', '/platform/embedding', '/platform/billing',
    '/platform/usage', '/platform/pieces/piece-sets/example',
    '/platform/workers/groups', '/impact', '/releases', '/approvals',
    '/projects/example/releases/123', '/projects/example/approvals',
  ])('excludes unavailable route %s', (pathname) => {
    expect(releaseAvailability.isRouteAvailable({ pathname })).toBe(false);
  });

  it.each([
    '/chat', '/agents', '/platform/projects', '/platform/users',
    '/connections', '/projects/example/connections', '/platform/pieces', '/platform/ai',
    '/platform/ai/capabilities', '/platform/mcp', '/platform/mcp/activity',
    '/platform/workers', '/platform/health', '/platform/health/runs',
    '/platform/health/queue', '/platform/triggers', '/platform/general',
    '/platform/configurations', '/templates', '/projects/example/automations',
    '/projects/example/agents/example', '/platform/users/roles-extra',
  ])('retains supported route %s', (pathname) => {
    expect(releaseAvailability.isRouteAvailable({ pathname })).toBe(true);
  });

  it('handles query strings without hiding the containing supported page', () => {
    expect(releaseAvailability.isRouteAvailable({ pathname: '/platform/templates?search=test' })).toBe(false);
    expect(releaseAvailability.isRouteAvailable({ pathname: '/platform/pieces?name=odoo' })).toBe(true);
  });

  it('does not advertise unavailable destinations in command search', () => {
    expect(STATIC_PAGES.some((page) => page.href === '/platform/templates')).toBe(false);
    expect(STATIC_PAGES.some((page) => page.href === '/impact')).toBe(false);
    expect(STATIC_PAGES.some((page) => page.href === '/templates')).toBe(true);
    expect(STATIC_PAGES.some((page) => page.href === '/platform/ai')).toBe(true);
  });

  it('does not offer unsupported team project creation', () => {
    expect(releaseAvailability.teamProjects).toBe(false);
  });
});
