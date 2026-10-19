import {
  PlatformRole,
  ProjectType,
  UserStatus,
  type UserWithMetaInformation,
} from '@activepieces/shared';

type ProjectNavigationRow = {
  platformId: string;
  type: ProjectType;
  ownerId: string | null;
};

// Presentation only: /projects already checks current persisted membership and
// assignments. Never bring a cached project from another workspace into the rail.
export function isProjectVisibleInNavigation({
  project,
  user,
  userId,
  platformId,
}: {
  project: ProjectNavigationRow;
  user: UserWithMetaInformation | null;
  userId: string | null;
  platformId: string | null;
}): boolean {
  if (!platformId || project.platformId !== platformId) return false;
  const operational =
    user !== null &&
    user.id === userId &&
    user.platformId === platformId &&
    user.status === UserStatus.ACTIVE &&
    user.platformRole === PlatformRole.OPERATOR &&
    user.externalId?.startsWith('sydekyks-operational:');
  return Boolean(
    operational ||
      project.type === ProjectType.TEAM ||
      (project.type === ProjectType.PERSONAL && project.ownerId === userId),
  );
}
