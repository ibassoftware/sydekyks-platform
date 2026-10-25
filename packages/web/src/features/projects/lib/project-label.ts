import { t } from 'i18next';

type NamedProject = { id: string; displayName: string };

// Only compare projects already returned by the current authorized collection.
export function projectReference(
  project: NamedProject,
  projects: readonly NamedProject[],
): string | null {
  const peers = projects.filter(
    (other) =>
      other.id !== project.id && other.displayName === project.displayName,
  );
  if (!peers.length) return null;
  let length = 6;
  while (
    length < project.id.length &&
    peers.some((other) => other.id.slice(-length) === project.id.slice(-length))
  )
    length++;
  return `…${project.id.slice(-length)}`;
}

export function projectSelectionLabel(
  project: NamedProject,
  projects: readonly NamedProject[],
): string {
  const reference = projectReference(project, projects);
  return reference
    ? `${project.displayName} · ${t('Reference')} ${reference}`
    : project.displayName;
}
