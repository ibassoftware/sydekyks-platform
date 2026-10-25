// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mutateCalls: { goLive?: boolean }[] = [];

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
  ModelPicker: () => <div data-testid="model" />,
  useKnowledgeBaseEmbeddingSource: () => ({ data: undefined }),
  AgentStructuredOutput: () => <div data-testid="structured" />,
  KnowledgeBaseSection: () => <div data-testid="knowledge" />,
  useAgentsAvailable: () => true,
}));
vi.mock('@/features/agents/hooks/agents-hooks', () => ({
  agentsMutations: {
    useUpdateAgent: () => ({
      isPending: false,
      mutate: (request: { goLive?: boolean }) => {
        mutateCalls.push(request);
      },
    }),
  },
  agentsQueries: { useAgent: () => ({ data: undefined, isLoading: false }) },
}));

import { AgentConfigurePanel } from '@/app/routes/agents/id/configure-panel';

const agent = {
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
    provider: 'openai',
    providerConfigId: null,
    modelName: 'gpt-5',
    maxSteps: 10,
    tools: [],
    structuredOutput: [],
  },
} as never;

const renderScreen = () => {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AgentConfigurePanel agent={agent} onExit={vi.fn()} />,
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

const typeInInstructions = (value: string) => {
  const box = screen.getByRole('textbox', { name: /^Instructions/ });
  fireEvent.change(box, { target: { value } });
};

beforeEach(() => {
  mutateCalls.length = 0;
});

describe('the configure panel never lets two writes race', () => {
  it('issues one write when the form is submitted twice before the first settles', async () => {
    renderScreen();
    typeInInstructions('Sort the inbox differently.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publish & test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish & test' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(mutateCalls).toHaveLength(1);
  });

  it('a lone save still goes live, so the lock does not block ordinary use', async () => {
    renderScreen();
    typeInInstructions('Sort the inbox differently.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publish & test' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(mutateCalls).toHaveLength(1);
    expect(mutateCalls[0]?.goLive).toBe(true);
  });
});
