/** @vitest-environment jsdom */
/* eslint-disable testing-library/no-unnecessary-act */
import { ColorName, Project, ProjectType } from '@activepieces/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewBlankAgentButton } from '@/features/agents/new-blank-agent-button';

vi.mock('@/features/projects', () => ({
  getProjectName: (project: Project) => project.displayName,
}));

function project(id: string, type: ProjectType): Project {
  return {
    id,
    type,
    displayName: id,
    ownerId: 'owner',
    platformId: 'platform',
    created: '2026-10-18T00:00:00Z',
    updated: '2026-10-18T00:00:00Z',
    deleted: null,
    maxConcurrentJobs: null,
    icon: { color: ColorName.PURPLE },
    externalId: null,
    releasesEnabled: false,
    notifyFlowOwnerOnFailure: false,
    metadata: null,
    poolId: null,
    pieceSetId: null,
    workerGroupId: null,
    executionDataRetentionDays: null,
    sensitive: false,
  };
}

const personal = project('personal', ProjectType.PERSONAL);
const team = project('team', ProjectType.TEAM);
const containers: {
  root: ReturnType<typeof createRoot>;
  element: HTMLDivElement;
}[] = [];

afterEach(() => {
  for (const { root, element } of containers.splice(0)) {
    act(() => root.unmount());
    element.remove();
  }
});

function render({
  projects,
  projectId,
  pending = false,
}: {
  projects: Project[];
  projectId?: string;
  pending?: boolean;
}) {
  const onCreate = vi.fn();
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  containers.push({ root, element });
  act(() =>
    root.render(
      <NewBlankAgentButton
        projects={projects}
        projectId={projectId}
        pending={pending}
        onCreate={onCreate}
        label="Create manually"
        icon={null}
      />
    )
  );
  return { onCreate, button: element.querySelector('button')! };
}

describe('manual creation destination', () => {
  it('honors the chosen team instead of silently creating in the personal project', () => {
    const { onCreate, button } = render({
      projects: [personal, team],
      projectId: team.id,
    });
    act(() => button.click());
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(team.id);
  });

  it('creates directly when there is only one team project', () => {
    const { onCreate, button } = render({ projects: [team] });
    act(() => button.click());
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(team.id);
  });

  it('prevents duplicate submissions while creation is pending', () => {
    const { onCreate, button } = render({
      projects: [personal],
      pending: true,
    });
    act(() => button.click());
    expect(button.disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('does not fall back to a different project when the selected destination is unavailable', () => {
    const { onCreate, button } = render({
      projects: [personal],
      projectId: 'removed-team',
    });
    act(() => button.click());
    expect(button.disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
