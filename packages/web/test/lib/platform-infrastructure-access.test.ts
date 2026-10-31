import { describe, expect, it } from 'vitest';
import { canAccessPlatformInfrastructure } from '@/lib/platform-infrastructure-access';
describe('hosted shared infrastructure routes', () => {
  it.each([
    '/platform/workers',
    '/platform/workers/groups',
    '/PLATFORM/WORKERS/',
    '/platform/health',
    '/platform/health/?tab=system',
    '/platform/infrastructure',
    '/platform/infrastructure/workers',
    '/platform/infrastructure/health',
  ])(
    'denies tenant admins on %s, retaining operator/self-hosted access',
    (pathname) => {
      expect(
        canAccessPlatformInfrastructure({
          pathname,
          hosted: true,
          operatorAllowed: false,
        }),
      ).toBe(false);
      expect(
        canAccessPlatformInfrastructure({
          pathname,
          hosted: true,
          operatorAllowed: true,
        }),
      ).toBe(true);
      expect(
        canAccessPlatformInfrastructure({
          pathname,
          hosted: false,
          operatorAllowed: false,
        }),
      ).toBe(true);
    },
  );
  it.each([
    '/platform/health/runs',
    '/platform/health/queue',
    '/platform/users',
  ])('keeps workspace administration available at %s', (pathname) => {
    expect(
      canAccessPlatformInfrastructure({
        pathname,
        hosted: true,
        operatorAllowed: false,
      }),
    ).toBe(true);
  });
});
