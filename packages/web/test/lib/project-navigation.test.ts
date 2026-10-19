import {
  PlatformRole,
  ProjectType,
  UserStatus,
  type UserWithMetaInformation,
} from '@activepieces/shared';
import { describe, expect, it } from 'vitest';

import { isProjectVisibleInNavigation } from '@/features/projects/stores/project-navigation';

const user = {
  id: 'current-user',
  platformId: 'current-platform',
  status: UserStatus.ACTIVE,
  platformRole: PlatformRole.OPERATOR,
  externalId: 'sydekyks-operational:partner-identity',
} as UserWithMetaInformation;
const project = {
  platformId: 'current-platform',
  type: ProjectType.PERSONAL,
  ownerId: 'client-owner',
};
const visible = (row = project, currentUser = user) =>
  isProjectVisibleInNavigation({
    project: row,
    user: currentUser,
    userId: user.id,
    platformId: user.platformId,
  });

describe('server-scoped project navigation', () => {
  it('shows the assigned client personal project to its operational user', () => {
    expect(visible()).toBe(true);
  });
  it('keeps another owner personal project hidden for ordinary operators', () => {
    expect(visible(project, { ...user, externalId: null })).toBe(false);
    expect(
      visible({ ...project, ownerId: user.id }, { ...user, externalId: null }),
    ).toBe(true);
    expect(
      visible(
        { ...project, type: ProjectType.TEAM },
        { ...user, externalId: null },
      ),
    ).toBe(true);
  });
  it('hides cached other-workspace rows even from an operational user', () => {
    expect(visible({ ...project, platformId: 'other-platform' })).toBe(false);
    expect(
      visible({
        ...project,
        type: ProjectType.TEAM,
        platformId: 'other-platform',
      }),
    ).toBe(false);
  });
  it('does not use stale or inactive user metadata to widen the rail', () => {
    expect(visible(project, { ...user, id: 'old-user' })).toBe(false);
    expect(visible(project, { ...user, platformId: 'old-platform' })).toBe(
      false,
    );
    expect(visible(project, { ...user, status: UserStatus.INACTIVE })).toBe(
      false,
    );
    expect(
      visible(project, { ...user, platformRole: PlatformRole.MEMBER }),
    ).toBe(false);
  });
});
