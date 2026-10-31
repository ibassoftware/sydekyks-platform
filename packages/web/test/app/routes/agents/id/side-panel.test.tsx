// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute, testing-library/no-node-access -- These isolated layout tests use native DOM assertions without a jest-dom runtime. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/app/components/locked-feature-guard', () => ({
  LockedFeatureGuard: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock('@/features/agents', () => ({ useAgentsAvailable: () => true }));
vi.mock('@/features/agents/agent-mark', () => ({ AgentMark: () => null }));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { appendProjectRoutePrefix: (path: string) => path },
}));
vi.mock('@/features/agents/hooks/agents-hooks', () => ({
  agentsQueries: {
    useAgent: () => ({
      isLoading: false,
      isError: false,
      data: {
        id: 'agent_1',
        displayName: 'Travel Desk',
        description: null,
        published: { provider: 'openai', modelName: 'gpt-5', tools: [] },
        draft: { provider: 'openai', modelName: 'gpt-5', tools: [] },
      },
    }),
  },
}));
vi.mock('@/app/routes/agents/id/agent-chat-view', () => ({
  AgentChatView: ({
    conversationsOpen,
    onCollapseConversations,
    onExpandConversations,
  }: {
    conversationsOpen: boolean;
    onCollapseConversations: () => void;
    onExpandConversations: () => void;
  }) => (
    <div data-testid="chat" data-conversations={String(conversationsOpen)}>
      <input aria-label="Draft message" />
      <button type="button" onClick={onExpandConversations}>
        expand-list
      </button>
      <button type="button" onClick={onCollapseConversations}>
        collapse-list
      </button>
    </div>
  ),
}));
vi.mock('@/app/routes/agents/id/runs', () => ({
  AgentRuns: () => <div data-testid="runs-panel" />,
}));
vi.mock('@/app/routes/agents/id/configure-panel', () => ({
  AgentConfigurePanel: forwardRef<
    { requestExit: () => void },
    { onExit: () => void }
  >(function ConfigurePanelMock({ onExit }, ref) {
    useImperativeHandle(ref, () => ({ requestExit: onExit }));
    return <div data-testid="configure-panel" />;
  }),
}));

import { AgentEditorPage } from '@/app/routes/agents/id';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sydekyk configuration and chat', () => {
  it('opens a new Sydekyk in Configure without mounting a competing chat', () => {
    renderPage('/agents/agent_1', true);
    expect(screen.getByTestId('configure-panel')).toBeTruthy();
    expect(screen.queryByTestId('chat')).toBeNull();
    expect(sidePanel().className).toContain('w-full');
    click('Chat with agent');
    expect(screen.getByTestId('chat')).toBeTruthy();
    expect(screen.getByTestId('chat').getAttribute('data-conversations')).toBe(
      'false',
    );
  });

  it('keeps a chat draft and the user’s history selection when Configure opens and closes', async () => {
    renderPage('/agents/agent_1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft message' }), {
      target: { value: 'Unsent draft' },
    });
    click('expand-list');
    click('Configure');
    expect(screen.getByTestId('chat').parentElement?.className).toContain(
      'hidden',
    );
    expect(sidePanel().className).toContain('w-full');
    click('Chat with agent');
    expect(
      screen.getByRole('textbox', {
        name: 'Draft message',
      }) as HTMLInputElement,
    ).toMatchObject({ value: 'Unsent draft' });
    expect(screen.getByTestId('chat').getAttribute('data-conversations')).toBe(
      'true',
    );
    await waitFor(() =>
      expect(screen.queryByTestId('configure-panel')).toBeNull(),
    );
  });

  it.each([390, 1440])(
    'gives configuration the full available width at %s pixels',
    (width) => {
      vi.stubGlobal('innerWidth', width);
      renderPage('/agents/agent_1');
      click('Configure');
      expect(sidePanel().className).toContain('w-full');
      expect(screen.getByTestId('chat').parentElement?.className).toContain(
        'hidden',
      );
      click('Configure');
      expect(sidePanel().className).toContain('w-0');
    },
  );

  it('swaps full-width Run history for Configure', async () => {
    renderPage('/agents/agent_1/runs');
    expect(await screen.findByTestId('runs-panel')).toBeTruthy();
    click('Configure');
    expect(screen.getByTestId('configure-panel')).toBeTruthy();
    expect(screen.queryByTestId('runs-panel')).toBeNull();
    expect(sidePanel().className).toContain('w-full');
  });

  it('retains history during its closing transition, then returns to chat', async () => {
    renderPage('/agents/agent_1');
    click('Run history');
    expect(await screen.findByTestId('runs-panel')).toBeTruthy();
    click('Run history');
    expect(sidePanel().className).toContain('w-0');
    expect(screen.getByTestId('runs-panel')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('runs-panel')).toBeNull());
    expect(screen.getByTestId('chat').getAttribute('data-conversations')).toBe(
      'false',
    );
  });
});

function renderPage(path: string, configure = false) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state: { configure } }]}>
      <Routes>
        <Route path="/agents/:agentId" element={<AgentEditorPage />} />
        <Route path="/agents/:agentId/runs" element={<AgentEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}
function sidePanel(): HTMLElement {
  const panel = document.querySelector('aside');
  if (!panel) throw new Error('Configuration panel not rendered');
  return panel;
}
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => false,
}));
