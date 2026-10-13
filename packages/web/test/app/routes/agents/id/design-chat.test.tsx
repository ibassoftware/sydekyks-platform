// @vitest-environment jsdom
import { Agent, AgentIcon, AgentVisibility, ColorName } from '@activepieces/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => {
  const chat: DesignChat = { builder: false, conversationId: null, onConversationCreated: (_id: string) => {} };
  return { chat, invalidate: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: control.invalidate }) }));
vi.mock('@/hooks/authorization-hooks', () => ({ useAuthorization: () => ({ checkAccess: () => true }) }));
vi.mock('@/lib/authentication-session', () => ({ authenticationSession: { getCurrentUserId: () => 'user' } }));
vi.mock('@/app/routes/chat-with-ai/ai-chat-box', () => ({ AIChatBox: (props: typeof control.chat) => { control.chat = props; return <div>Conversation</div>; } }));
vi.mock('@/app/routes/chat-with-ai/conversation-list', () => ({ ConversationList: () => <div>Behavior conversations</div> }));
vi.mock('@/app/routes/chat-with-ai/components/conversations-toggle', () => ({ ConversationsToggle: () => <div>Toggle</div> }));
vi.mock('@/features/agents/agent-chat-welcome', () => ({ AgentChatWelcome: () => <div>Welcome</div> }));

import { AgentChatView } from '@/app/routes/agents/id/agent-chat-view';

const agent = Agent.parse({ id: 'a'.repeat(21), projectId: 'p'.repeat(21), ownerId: 'u'.repeat(21), externalId: 'e'.repeat(21), folderId: null, displayName: 'Greeting', description: null, icon: AgentIcon.SPARKLES, color: ColorName.PURPLE, visibility: AgentVisibility.PROJECT, sharedWithUserIds: [], created: '2026-10-07T00:00:00Z', updated: '2026-10-07T00:00:00Z', draft: { instructions: 'Say hello', tools: [], structuredOutput: [], maxSteps: 5 }, published: null });

function view({ beforeDesignSend = () => true }: { beforeDesignSend?: () => boolean } = {}) {
  return render(<AgentChatView agent={agent} conversationsOpen openedConversationId="behavior" chatSessionKey="behavior" footerNote="Behavior" onSelectConversation={() => {}} onNewConversation={() => {}} onCollapseConversations={() => {}} onExpandConversations={() => {}} onConversationCreated={() => {}} onOpenConfigure={() => {}} onDesignRunStateChange={() => {}} beforeDesignSend={beforeDesignSend} />);
}

describe('agent design conversations', () => {
  beforeEach(() => {
    sessionStorage.clear();
    control.invalidate.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
  });
  it('uses a separate builder conversation and preserves the behavior conversation', () => {
    view();
    expect(control.chat.conversationId).toBe('behavior');
    fireEvent.click(screen.getByRole('button', { name: 'Design with Syd' }));
    expect(control.chat.builder).toBe(true);
    expect(control.chat.conversationId).toBeNull();
    act(() => control.chat.onConversationCreated('design'));
    expect(sessionStorage.getItem(`syd-agent-builder:user:${agent.id}`)).toBe('design');
    fireEvent.click(screen.getByRole('button', { name: 'Chat with agent' }));
    expect(control.chat.builder).toBe(false);
    expect(control.chat.conversationId).toBe('behavior');
    fireEvent.click(screen.getByRole('button', { name: 'Design with Syd' }));
    expect(control.chat.conversationId).toBe('design');
  });
  it('blocks a design request while manual configuration changes need saving', () => {
    view({ beforeDesignSend: () => false });
    fireEvent.click(screen.getByRole('button', { name: 'Design with Syd' }));
    act(() => { expect(control.chat.beforeSend?.()).toBe(false); });
    expect(screen.getByRole('alert').textContent).toContain('Save or discard');
  });
  it('keeps design edits locked after a failed refresh until retry succeeds', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Design with Syd' }));
    act(() => control.chat.onRunStateChange?.(true));
    control.invalidate.mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { control.chat.onRunStateChange?.(false); });
    expect(screen.getByRole('alert').textContent).toContain('Could not refresh');
    expect(screen.getByRole('button', { name: 'Chat with agent' }).hasAttribute('disabled')).toBe(true);
    expect(control.chat.beforeSend?.()).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chat with agent' }).hasAttribute('disabled')).toBe(false);
  });
  it('waits for the configuration refresh before releasing the design mode lock', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Design with Syd' }));
    act(() => control.chat.onRunStateChange?.(true));
    expect(screen.getByRole('button', { name: 'Chat with agent' }).hasAttribute('disabled')).toBe(true);
    let finish: (() => void) | undefined;
    control.invalidate.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    act(() => control.chat.onRunStateChange?.(false));
    expect(screen.getByRole('button', { name: 'Chat with agent' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { finish?.(); });
    expect(screen.getByRole('button', { name: 'Chat with agent' }).hasAttribute('disabled')).toBe(false);
  });
});

type DesignChat = { builder?: boolean; conversationId: string | null; onConversationCreated: (id: string) => void; beforeSend?: () => boolean; onRunStateChange?: (active: boolean) => void };
