// @vitest-environment jsdom
// These assertions use native DOM properties because no jest-dom runtime is installed.
/* eslint-disable jest-dom/prefer-to-have-attribute, jest-dom/prefer-in-document, jest-dom/prefer-to-have-text-content, jest-dom/prefer-to-have-value */
import { AgentConversation } from '@activepieces/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationList } from '@/app/routes/chat-with-ai/conversation-list';

const state = vi.hoisted(() => ({
  token: null as string | null,
  conversation: {} as AgentConversation,
  list: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getToken: () => state.token,
    isJwtExpired: () => false,
  },
}));
vi.mock('@/app/components/settings-hub/settings-hub-dialog', () => ({
  SettingsHubDialog: () => null,
}));
vi.mock('@/features/chat/lib/chat-utils', () => ({
  chatUtils: { sanitizeTitle: (value: string) => value },
}));
vi.mock('@/features/chat/lib/use-conversation-indicators', () => ({
  useConversationIndicators: () => ({
    getIndicator: () => null,
    markRead: () => undefined,
  }),
}));
vi.mock('@/features/chat/lib/chat-api', () => ({
  chatApi: {
    listConversations: (...args: unknown[]) => state.list(...args),
    updateConversation: (...args: unknown[]) => state.update(...args),
    deleteConversation: (...args: unknown[]) => state.remove(...args),
  },
}));
function token(id: string) {
  return `e30.${btoa(
    JSON.stringify({ id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  )}.signature`;
}
function conversation(id = 'chat-one', title = 'Original title') {
  return { id, title, created: new Date().toISOString() } as AgentConversation;
}
let client: QueryClient;
function mount(onTitleChanged = vi.fn()) {
  render(
    <QueryClientProvider client={client}>
      <ConversationList onTitleChanged={onTitleChanged} selectedId="chat-one" />
    </QueryClientProvider>,
  );
  return onTitleChanged;
}
beforeEach(() => {
  state.token = token('first-user');
  state.conversation = conversation();
  state.list.mockReset().mockImplementation(async () => ({
    data: [state.conversation],
    next: null,
    previous: null,
  }));
  state.update
    .mockReset()
    .mockImplementation(async (_id: string, request: { title: string }) => {
      state.conversation = { ...state.conversation, title: request.title };
      return state.conversation;
    });
  state.remove.mockReset().mockResolvedValue(undefined);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  client.clear();
});
async function startRename() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Rename conversation' }),
  );
  return screen.getByRole('textbox', { name: 'Conversation title' });
}
describe('conversation rename in self-hosted mode', () => {
  it('saves a trimmed title through the existing scoped API and refreshes its list', async () => {
    const changed = mount();
    fireEvent.change(await startRename(), {
      target: { value: '  Hiring review  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Hiring review' });
    expect(state.update).toHaveBeenCalledWith('chat-one', {
      title: 'Hiring review',
    });
    expect(changed).toHaveBeenCalledWith('chat-one', 'Hiring review');
    expect(state.list.mock.calls.length).toBeGreaterThan(1);
  });
  it('rejects a blank title and allows Escape without sending a rename', async () => {
    mount();
    const input = await startRename();
    fireEvent.change(input, { target: { value: '  ' } });
    expect(
      screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(
      screen.queryByRole('textbox', { name: 'Conversation title' }),
    ).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });
  it('keeps the edited value and offers retry when saving fails', async () => {
    state.update.mockRejectedValueOnce(new Error('Connection interrupted'));
    mount();
    fireEvent.change(await startRename(), {
      target: { value: 'Keep my draft title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Title could not be saved. Try again.',
    );
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Conversation title',
        }) as HTMLInputElement
      ).value,
    ).toBe('Keep my draft title');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Keep my draft title' });
  });
  it('does not apply a delayed rename or error to a newly signed-in account', async () => {
    let resolve!: (result: AgentConversation) => void;
    state.update.mockImplementationOnce(
      () =>
        new Promise<AgentConversation>((done) => {
          resolve = done;
        }),
    );
    const changed = mount();
    fireEvent.change(await startRename(), {
      target: { value: 'Old account title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    act(() => {
      state.token = token('second-user');
      state.conversation = conversation('chat-two', 'New account conversation');
      window.dispatchEvent(new Event('storage'));
    });
    await screen.findByRole('button', { name: 'New account conversation' });
    await act(async () => {
      resolve(conversation('chat-one', 'Old account title'));
    });
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Old account title' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'New account conversation' }),
    ).toBeTruthy();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ),
    ).not.toContain(state.token);
  });
});
