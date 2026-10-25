// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-value -- This isolated Vitest suite does not install jest-dom matchers. */
import { AIProviderName } from '@activepieces/core-utils';
import { Agent, ModelChoice } from '@activepieces/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pendingSaves: { onSuccess?: () => void }[] = [];

vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@/app/routes/chat-with-ai/ai-chat-box', () => ({
  AIChatBox: () => <div data-testid="chat" />,
}));
vi.mock('@/app/builder/step-settings/agent-settings/agent-tools', () => ({
  AgentTools: () => <div data-testid="tools" />,
}));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: true }) },
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({ checkAccess: () => true }),
}));
vi.mock('@/features/projects', () => ({
  projectCollectionUtils: { useAll: () => ({ data: [] }) },
  getProjectName: () => '',
  ApProjectDisplay: () => null,
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getCurrentUserId: () => 'owner' },
}));
vi.mock('@/features/agents', () => ({
  ModelPicker: ({ onChange }: { onChange: (value: ModelChoice) => void }) => (
    <>
      <button
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
        data-testid="tier"
        onClick={() => onChange({ type: 'tier', tierId: 'tier-1' })}
      />
    </>
  ),
  useKnowledgeBaseEmbeddingSource: () => ({ data: undefined }),
  AgentStructuredOutput: () => <div data-testid="structured" />,
  KnowledgeBaseSection: () => <div data-testid="knowledge" />,
  useAgentsAvailable: () => true,
}));
vi.mock('@/features/agents/hooks/agents-hooks', () => ({
  agentsMutations: {
    useUpdateAgent: () => ({
      isPending: false,
      mutate: (
        request: Partial<Agent>,
        options?: { onSuccess?: (saved: Agent) => void },
      ) => {
        pendingSaves.push({
          onSuccess: () =>
            options?.onSuccess?.({ ...agentWithoutModel, ...request } as Agent),
        });
      },
    }),
  },
  agentsQueries: { useAgent: () => ({ data: undefined, isLoading: false }) },
}));

import { AgentConfigurePanel } from '@/app/routes/agents/id/configure-panel';

const agentWithoutModel = {
  id: 'agent_1',
  displayName: 'Inbox agent',
  description: null,
  icon: 'bot',
  color: 'PURPLE',
  projectId: 'proj_1',
  visibility: 'PROJECT',
  sharedWithUserIds: [],
  published: null,
  draft: {
    instructions: 'Sort the inbox.',
    provider: null,
    providerConfigId: null,
    modelName: null,
    maxSteps: 10,
    tools: [],
    structuredOutput: [],
  },
} as unknown as Agent;

const renderScreen = ({ onExit }: { onExit: () => void }) => {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <AgentConfigurePanel agent={agentWithoutModel} onExit={onExit} />
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

const clickBack = () => {
  const back = screen.getByRole('button', { name: 'Chat with Sydekyk' });
  fireEvent.click(back);
};

const typeInInstructions = (value: string) => {
  const box = screen.getByRole('textbox', { name: /^Instructions/ });
  fireEvent.change(box, { target: { value } });
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

beforeEach(() => {
  pendingSaves.length = 0;
});

describe('the leave guard only speaks for edits a person made', () => {
  it('asks for a model on a blank agent until a tier is picked', async () => {
    renderScreen({ onExit: vi.fn() });
    await settle();
    expect(
      screen.getByText('Pick a model so this agent can answer.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('tier'));
    await settle();

    expect(
      screen.queryByText('Pick a model so this agent can answer.'),
    ).toBeNull();
  });

  it('still stops you when the model was picked by hand', async () => {
    const onExit = vi.fn();
    renderScreen({ onExit });
    await settle();

    fireEvent.click(screen.getByTestId('model'));
    await settle();
    clickBack();
    await settle();

    expect(screen.getByText('Leave without saving?')).toBeTruthy();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('keeps an edit typed while a save was in flight', async () => {
    const onExit = vi.fn();
    renderScreen({ onExit });
    typeInInstructions('First edit.');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Publish & test' }));
    await settle();
    expect(pendingSaves).toHaveLength(1);

    typeInInstructions('Second edit, typed while saving.');
    await settle();
    act(() => {
      pendingSaves[0]?.onSuccess?.();
    });
    await settle();

    expect(
      (
        screen.getByRole('textbox', {
          name: /^Instructions/,
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Second edit, typed while saving.');
    clickBack();
    await settle();
    expect(screen.getByText('Leave without saving?')).toBeTruthy();
  });
});
