// @vitest-environment jsdom
import {
  Agent,
  AgentIcon,
  AgentVisibility,
  ColorName,
} from '@activepieces/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => {
  const chat: DesignChat = {
    builder: false,
    conversationId: null,
    onConversationCreated: (_id: string) => {},
  };
  return { chat, invalidate: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: control.invalidate }),
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({ checkAccess: () => true }),
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getCurrentUserId: () => 'user' },
}));
vi.mock('@/app/routes/chat-with-ai/ai-chat-box', () => ({
  AIChatBox: (props: typeof control.chat) => {
    control.chat = props;
    return <div>Conversation</div>;
  },
}));
vi.mock('@/app/routes/chat-with-ai/conversation-list', () => ({
  ConversationList: () => <div>Behavior conversations</div>,
}));
vi.mock('@/app/routes/chat-with-ai/components/conversations-toggle', () => ({
  ConversationsToggle: () => <div>Toggle</div>,
}));
vi.mock('@/features/agents/agent-chat-welcome', () => ({
  AgentChatWelcome: () => <div>Welcome</div>,
}));

import { AgentChatView } from '@/app/routes/agents/id/agent-chat-view';

const agent = Agent.parse({
  id: 'a'.repeat(21),
  projectId: 'p'.repeat(21),
  ownerId: 'u'.repeat(21),
  externalId: 'e'.repeat(21),
  folderId: null,
  displayName: 'Greeting',
  description: null,
  icon: AgentIcon.SPARKLES,
  color: ColorName.PURPLE,
  visibility: AgentVisibility.PROJECT,
  sharedWithUserIds: [],
  created: '2026-10-07T00:00:00Z',
  updated: '2026-10-07T00:00:00Z',
  draft: {
    instructions: 'Say hello',
    tools: [],
    structuredOutput: [],
    maxSteps: 5,
  },
  published: null,
});

function view() {
  return render(
    <AgentChatView
      agent={agent}
      conversationsOpen={false}
      openedConversationId="behavior"
      chatSessionKey="behavior"
      footerNote="Behavior"
      onSelectConversation={() => {}}
      onNewConversation={() => {}}
      onCollapseConversations={() => {}}
      onExpandConversations={() => {}}
      onConversationCreated={() => {}}
    />,
  );
}

describe('configured Sydekyk chat', () => {
  it('uses the selected Sydekyk conversation without a design mode', () => {
    view();
    expect(control.chat.conversationId).toBe('behavior');
    expect(control.chat.builder).not.toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Design with Syd' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Behavior conversations'),
    ).not.toBeInTheDocument();
  });
});

type DesignChat = {
  builder?: boolean;
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
};
