export type HostedDocumentSession = {
  token: string | null;
  projectId: string | null;
  kind: 'anonymous' | 'onboarding' | 'user';
  id: string | null;
  platformId: string | null;
};

// Preserve only the project-list destination that the rail has just selected.
// The new document still checks project membership before showing any content.
export function hostedDocumentReloadPath(
  initial: HostedDocumentSession,
  current: HostedDocumentSession,
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  checkoutPending = false,
): string {
  if (current.kind === 'anonymous') return '/sign-in';
  if (current.kind === 'user' && checkoutPending) return '/platform/billing';
  const sameAccount =
    initial.kind === 'user' &&
    current.kind === 'user' &&
    !!current.token &&
    current.token === initial.token &&
    !!current.id &&
    current.id === initial.id &&
    !!current.platformId &&
    current.platformId === initial.platformId;
  const projectId = current.projectId;
  if (
    sameAccount &&
    projectId &&
    /^[A-Za-z0-9_-]+$/.test(projectId) &&
    location.pathname === `/projects/${projectId}/automations` &&
    location.search === '' &&
    location.hash === ''
  ) {
    return `/projects/${projectId}/automations`;
  }
  return '/';
}
