// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => true,
}));
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
        displayName: 'QA Assistant',
        description: 'Answer a question',
        draft: { tools: [] },
        published: { tools: [] },
      },
    }),
  },
}));
vi.mock('@/app/routes/agents/id/agent-chat-view', () => ({
  AgentChatView: ({
    conversationsOpen,
    onExpandConversations,
    onCollapseConversations,
  }: {
    conversationsOpen: boolean;
    onExpandConversations: () => void;
    onCollapseConversations: () => void;
  }) => (
    <div>
      <p>{conversationsOpen ? 'History open' : 'Chat fills the page'}</p>
      <button onClick={onExpandConversations}>Open history</button>
      <button onClick={onCollapseConversations}>Close history</button>
    </div>
  ),
}));
vi.mock('@/app/routes/agents/id/runs', () => ({ AgentRuns: () => null }));
vi.mock('@/app/routes/agents/id/configure-panel', () => ({
  AgentConfigurePanel: () => null,
}));

import { AgentEditorPage } from '@/app/routes/agents/id';

function view(width: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', () => ({
    matches: width >= 1280,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  return render(
    <MemoryRouter initialEntries={['/agents/agent_1']}>
      <Routes>
        <Route path="/agents/:agentId" element={<AgentEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('Agent mobile conversation history', () => {
  it('starts collapsed at a phone viewport and remains controlled by the history actions', () => {
    view(390);
    expect(screen.queryAllByText('Chat fills the page')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }));
    expect(screen.queryAllByText('History open')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close history' }));
    expect(screen.queryAllByText('Chat fills the page')).toHaveLength(1);
  });
  it('starts folded on desktop and opens only when requested', () => {
    view(1440);
    expect(screen.queryAllByText('Chat fills the page')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }));
    expect(screen.queryAllByText('History open')).toHaveLength(1);
  });
});
