// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document -- This isolated Vitest suite does not install jest-dom matchers. */
import {
  Agent,
  AgentConfig,
  AgentIcon,
  AgentVisibility,
  ColorName,
} from '@activepieces/shared';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const save = vi.hoisted(() => ({
  mutate: vi.fn(),
  callbacks: null as null | {
    onSuccess: (agent: Agent) => void;
    onSettled: () => void;
  },
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/features/agents/hooks/agents-hooks', () => ({
  agentsMutations: {
    useUpdateAgent: () => ({ mutate: save.mutate, isPending: false }),
  },
}));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => true,
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({
    checkAccess: () => false,
    isFetchingProjectRole: false,
  }),
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getCurrentUserId: () => 'owner' },
}));
vi.mock('@/lib/api', () => ({
  api: {
    extractServerErrorMessage: (_error: Error, fallback: string) => fallback,
  },
}));
vi.mock('@/features/projects', () => ({
  projectCollectionUtils: { useAll: () => ({ data: [] }) },
  getProjectName: () => '',
  ApProjectDisplay: () => null,
}));
vi.mock('@/features/agents', () => ({
  AgentStructuredOutput: () => null,
  ModelPicker: () => null,
  NoEmbeddingSourceNote: () => null,
  useKnowledgeBaseEmbeddingSource: () => ({ data: null }),
}));
vi.mock('@/features/agents/hosted-agent-provider-field', () => ({
  HostedAgentProviderField: () => <span>Sydekyks</span>,
}));
vi.mock('@/features/agents/move-agent-dialog', () => ({
  MoveAgentDialog: () => null,
}));
vi.mock('@/features/agents/delete-agent-dialog', () => ({
  DeleteAgentDialog: () => null,
}));
vi.mock('@/app/builder/step-settings/agent-settings/agent-tools', () => ({
  AgentTools: () => <span>Sydekyk Tools</span>,
}));
vi.mock('@/components/custom/leave-without-saving', () => ({
  useWarnBeforeLosingChanges: () => ({ state: 'unblocked' }),
  LeaveWithoutSavingDialog: ({ open }: { open: boolean }) =>
    open ? <div>Leave without saving?</div> : null,
}));

import { AgentConfigurePanel } from '@/app/routes/agents/id/configure-panel';

const base = (): Agent => {
  const draft = AgentConfig.parse({
    instructions: 'Use Addition for two numbers.',
  });
  return {
    id: 'agent-1',
    projectId: 'project-1',
    ownerId: 'owner',
    displayName: 'Adder',
    description: null,
    icon: AgentIcon.BOT,
    color: ColorName.PURPLE,
    visibility: AgentVisibility.RESTRICTED,
    sharedWithUserIds: [],
    draft,
    published: draft,
  } as unknown as Agent;
};

beforeEach(() => {
  save.callbacks = null;
  save.mutate.mockReset();
  save.mutate.mockImplementation((_request, callbacks) => {
    save.callbacks = callbacks;
  });
});

async function beginPublish() {
  fireEvent.change(screen.getByLabelText(/^Name/), {
    target: { value: 'Simple Adder' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Publish & test' }));
  await waitFor(() => expect(save.mutate).toHaveBeenCalledTimes(1));
}

describe('agent configuration publishing', () => {
  it('shows Name and Sharing in one screen and acknowledges its own published JSONB response', async () => {
    const agent = base(),
      onExit = vi.fn();
    const view = render(<AgentConfigurePanel agent={agent} onExit={onExit} />);
    expect(screen.getByLabelText('Sharing')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    await beginPublish();
    const saved = {
      ...agent,
      displayName: 'Simple Adder',
      draft: Object.fromEntries(
        Object.entries(agent.draft).reverse(),
      ) as AgentConfig,
    };
    view.rerender(<AgentConfigurePanel agent={saved} onExit={onExit} />);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await act(async () => {
      save.callbacks?.onSuccess(saved);
      save.callbacks?.onSettled();
    });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unsaved')).toBeNull();
    expect(screen.queryByText('Leave without saving?')).toBeNull();
  });

  it('keeps newer local edits after an older write completes and does not exit to chat', async () => {
    const agent = base(),
      onExit = vi.fn();
    const view = render(<AgentConfigurePanel agent={agent} onExit={onExit} />);
    await beginPublish();
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'Newer name' },
    });
    const saved = { ...agent, displayName: 'Simple Adder' };
    view.rerender(<AgentConfigurePanel agent={saved} onExit={onExit} />);
    await act(async () => {
      save.callbacks?.onSuccess(saved);
      save.callbacks?.onSettled();
    });
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      'Newer name',
    );
    expect(screen.getByText('Unsaved')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('preserves edits on a real conflict and asks before replacing them with the saved version', async () => {
    const agent = base(),
      onExit = vi.fn();
    const view = render(<AgentConfigurePanel agent={agent} onExit={onExit} />);
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'Local name' },
    });
    view.rerender(
      <AgentConfigurePanel
        agent={{ ...agent, displayName: 'Other editor' }}
        onExit={onExit}
      />,
    );
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Publish & test' })).toBeNull();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      'Local name',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load saved version' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      'Local name',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      'Local name',
    );
    expect(save.mutate).not.toHaveBeenCalled();
  });
  it('does not clear a newer external conflict when an older publish callback finally completes', async () => {
    const agent = base(),
      onExit = vi.fn();
    const view = render(<AgentConfigurePanel agent={agent} onExit={onExit} />);
    await beginPublish();
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'Newer local edit' },
    });
    const savedA = {
      ...agent,
      displayName: 'Simple Adder',
      updated: '2026-10-22T09:00:01.000Z',
    };
    view.rerender(<AgentConfigurePanel agent={savedA} onExit={onExit} />);
    const newerB = {
      ...savedA,
      displayName: 'Different server edit',
      updated: '2026-10-22T09:00:02.000Z',
    };
    view.rerender(<AgentConfigurePanel agent={newerB} onExit={onExit} />);
    await screen.findByRole('alert');
    await act(async () => {
      save.callbacks?.onSuccess(savedA);
      save.callbacks?.onSettled();
    });
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      'Newer local edit',
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish & test' })).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
  });
});
