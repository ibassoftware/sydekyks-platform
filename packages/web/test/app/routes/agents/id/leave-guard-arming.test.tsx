// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document -- This isolated Vitest suite does not install jest-dom matchers. */
import { AIProviderName } from '@activepieces/core-utils';
import {
  Agent,
  AgentConfig,
  AgentIcon,
  AgentVisibility,
  ColorName,
  ModelChoice,
  UpdateAgentRequest,
} from '@activepieces/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createContext, useContext } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ hosted: false }));
const pendingSaves: {
  request: UpdateAgentRequest;
  onSuccess?: (agent: Agent) => void;
  onSettled?: () => void;
}[] = [];

vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => fixture.hosted,
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getCurrentUserId: () => 'owner' },
}));
vi.mock('@/features/projects', () => ({
  projectCollectionUtils: { useAll: () => ({ data: [] }) },
  getProjectName: () => '',
  ApProjectDisplay: () => null,
}));
vi.mock('@/features/agents/move-agent-dialog', () => ({
  MoveAgentDialog: () => null,
}));
vi.mock('@/features/agents/delete-agent-dialog', () => ({
  DeleteAgentDialog: () => null,
}));
vi.mock('@/features/agents/hosted-agent-provider-field', () => ({
  HostedAgentProviderField: () => <span>Sydekyks</span>,
}));
vi.mock('@/app/builder/step-settings/agent-settings/agent-tools', () => ({
  AgentTools: () => <div data-testid="tools" />,
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({
    checkAccess: () => true,
    isFetchingProjectRole: false,
  }),
}));
vi.mock('@/features/agents', () => ({
  ModelPicker: ({ onChange }: { onChange: (value: ModelChoice) => void }) => (
    <>
      <button
        type="button"
        data-testid="model"
        onClick={() =>
          onChange({
            type: 'model',
            provider: AIProviderName.OPENAI,
            providerConfigId: 'key-1',
            modelId: 'gpt-5',
          })
        }
      />
      <button
        type="button"
        data-testid="tier"
        onClick={() => onChange({ type: 'tier', tierId: 'tier-1' })}
      />
    </>
  ),
  useKnowledgeBaseEmbeddingSource: () => ({ data: undefined }),
  AgentStructuredOutput: () => <div data-testid="structured" />,
  NoEmbeddingSourceNote: () => null,
}));
vi.mock('@/features/agents/hooks/agents-hooks', () => ({
  agentsMutations: {
    useUpdateAgent: () => ({
      isPending: false,
      mutate: (
        request: UpdateAgentRequest,
        options?: {
          onSuccess?: (agent: Agent) => void;
          onSettled?: () => void;
        },
      ) => {
        pendingSaves.push({ request, ...options });
      },
    }),
  },
}));

import { AgentConfigurePanel } from '@/app/routes/agents/id/configure-panel';

const agentWithoutModel: Agent = {
  id: 'agent_1',
  externalId: 'inbox-agent',
  created: '2026-10-26T00:00:00.000Z',
  updated: '2026-10-26T00:00:00.000Z',
  displayName: 'Inbox agent',
  description: null,
  icon: AgentIcon.BOT,
  color: ColorName.PURPLE,
  projectId: 'proj_1',
  ownerId: 'owner',
  visibility: AgentVisibility.PROJECT,
  sharedWithUserIds: [],
  published: null,
  draft: AgentConfig.parse({ instructions: 'Sort the inbox.' }),
};

const AgentContext = createContext(agentWithoutModel);
const CurrentAgentPanel = ({ onExit }: { onExit: () => void }) => (
  <AgentConfigurePanel agent={useContext(AgentContext)} onExit={onExit} />
);

const renderScreen = ({ onExit }: { onExit: () => void }) => {
  const router = createMemoryRouter(
    [{ path: '/', element: <CurrentAgentPanel onExit={onExit} /> }],
    { initialEntries: ['/'] },
  );
  const client = new QueryClient();
  const element = (agent: Agent) => (
    <AgentContext.Provider value={agent}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AgentContext.Provider>
  );
  const view = render(element(agentWithoutModel));
  return {
    refetchAgent: (agent: Agent) => view.rerender(element(agent)),
  };
};

const clickBack = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Chat with Sydekyk' }));

const typeInInstructions = (value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: /Instructions/ }), {
    target: { value },
  });

beforeEach(() => {
  fixture.hosted = false;
  pendingSaves.length = 0;
});

describe('the leave guard only speaks for edits a person made', () => {
  it('allows an untouched hosted agent to exit without asking for a model', () => {
    fixture.hosted = true;
    const onExit = vi.fn();
    renderScreen({ onExit });

    expect(screen.getByText('Sydekyks')).toBeTruthy();
    expect(
      screen.queryByText('Pick a model so this agent can answer.'),
    ).toBeNull();
    clickBack();
    expect(screen.queryByText('Leave without saving?')).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('asks for a model on a self-hosted blank agent until a tier is picked', async () => {
    renderScreen({ onExit: vi.fn() });
    expect(
      screen.getByText('Pick a model so this agent can answer.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('tier'));
    await waitFor(() =>
      expect(
        screen.queryByText('Pick a model so this agent can answer.'),
      ).toBeNull(),
    );
    clickBack();
    expect(await screen.findByText('Leave without saving?')).toBeTruthy();
  });

  it('still stops you when the model was picked by hand', async () => {
    const onExit = vi.fn();
    renderScreen({ onExit });

    fireEvent.click(screen.getByTestId('model'));
    await screen.findByText('Unsaved');
    clickBack();

    expect(await screen.findByText('Leave without saving?')).toBeTruthy();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('keeps an edit typed while a save and its refetch were in flight', async () => {
    fixture.hosted = true;
    const onExit = vi.fn();
    const view = renderScreen({ onExit });
    typeInInstructions('First edit.');
    fireEvent.click(screen.getByRole('button', { name: 'Publish & test' }));
    await waitFor(() => expect(pendingSaves).toHaveLength(1));
    expect(pendingSaves[0].request.draft?.instructions).toBe('First edit.');

    typeInInstructions('Second edit, typed while saving.');
    const saved = {
      ...agentWithoutModel,
      draft: AgentConfig.parse(pendingSaves[0].request.draft),
      published: AgentConfig.parse(pendingSaves[0].request.draft),
    };
    view.refetchAgent(saved);
    await act(async () => {
      pendingSaves[0].onSuccess?.(saved);
      pendingSaves[0].onSettled?.();
    });

    expect(screen.getByRole('textbox', { name: /Instructions/ })).toMatchObject(
      {
        value: 'Second edit, typed while saving.',
      },
    );
    expect(screen.getByText('Unsaved')).toBeTruthy();
    clickBack();
    expect(await screen.findByText('Leave without saving?')).toBeTruthy();
    expect(onExit).not.toHaveBeenCalled();
  });
});
