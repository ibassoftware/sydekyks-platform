import { Permission } from '@activepieces/core-utils';
import { describe, expect, it, vi } from 'vitest';

import { determineDefaultRoute } from '@/lib/route-utils';

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    appendProjectRoutePrefix: (path: string) => path,
  },
}));

const allow =
  (permissions: Permission[]) =>
  (permission: Permission): boolean =>
    permissions.includes(permission);

describe('determineDefaultRoute', () => {
  it('lands on Sydekyks only when the capability and read permission are available', () => {
    expect(
      determineDefaultRoute({
        agentsEnabled: true,
        checkAccess: allow([Permission.READ_AGENT, Permission.READ_FLOW]),
      }),
    ).toBe('/agents');
    expect(
      determineDefaultRoute({
        agentsEnabled: false,
        checkAccess: allow([Permission.READ_AGENT, Permission.READ_FLOW]),
      }),
    ).toBe('/automations');
    expect(
      determineDefaultRoute({
        agentsEnabled: true,
        checkAccess: allow([Permission.READ_RUN]),
      }),
    ).toBe('/runs');
  });
  it('routes based on the user permissions', () => {
    expect(
      determineDefaultRoute({ checkAccess: allow([Permission.READ_FLOW]) }),
    ).toBe('/automations');
    expect(
      determineDefaultRoute({ checkAccess: allow([Permission.READ_RUN]) }),
    ).toBe('/runs');
    expect(determineDefaultRoute({ checkAccess: () => false })).toBe(
      '/settings',
    );
  });
});
