// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-to-have-attribute, jest-dom/prefer-in-document, jest-dom/prefer-to-have-text-content -- This Vitest setup has no jest-dom matcher extension. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  chat: null as any,
  list: {
    data: [] as any[],
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  remove: vi.fn(),
}));
vi.mock('./hosted-chat-provider', () => ({
  useHostedChatPayer: () => state.chat,
}));
vi.mock('./hosted-native-files-api', () => ({
  hostedNativeFilesApi: { list: vi.fn(), remove: state.remove },
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => state.list }));
vi.mock('i18next', () => ({
  t: (value: string, vars?: Record<string, unknown>) =>
    value.replace(/{(\w+)}/g, (_, key) => String(vars?.[key] ?? '')),
}));

import {
  HostedNativeFileManager,
  HostedWebSearchControl,
} from './hosted-native-controls';

beforeEach(() => {
  vi.clearAllMocks();
  state.chat = {
    ready: true,
    nativeWebSearch: false,
    setNativeWebSearch: vi.fn(),
    payer: { type: 'managed' },
    scope: { session: { epoch: 'epoch' }, projectPointer: 'p'.repeat(21) },
    options: {
      nativeFeatures: {
        files: true,
        webSearch: true,
        maxTurnCredits: 100,
        maxFilesPerTurn: 4,
      },
    },
  };
  state.list.data = [];
  state.list.isPending = false;
  state.list.isError = false;
  state.remove.mockResolvedValue(undefined);
});
it('requires a deliberate Web opt-in and disables it while a send is running', () => {
  const view = render(<HostedWebSearchControl disabled={false} />);
  const web = screen.getByRole('button', { name: 'Search web' });
  expect(web.getAttribute('aria-pressed')).toBe('false');
  expect(state.chat.setNativeWebSearch).not.toHaveBeenCalled();
  fireEvent.click(web);
  expect(state.chat.setNativeWebSearch).toHaveBeenCalledWith(true);
  view.rerender(<HostedWebSearchControl disabled />);
  fireEvent.click(web);
  expect(state.chat.setNativeWebSearch).toHaveBeenCalledTimes(1);
});
it('keeps unsupported native controls hidden and never enables unavailable search', () => {
  state.chat.options.nativeFeatures.webSearch = false;
  const view = render(<HostedWebSearchControl disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Search web' }));
  expect(state.chat.setNativeWebSearch).not.toHaveBeenCalled();
  state.chat.options = {};
  view.rerender(
    <>
      <HostedWebSearchControl disabled={false} />
      <HostedNativeFileManager disabled={false} />
    </>,
  );
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows the managed turn ceiling and scopes file removal without exposing supplier details', async () => {
  const file = {
    id: 'f'.repeat(21),
    name: 'Fictional pilot brief.pdf',
    expiresAt: '2026-10-23T00:00:00Z',
  };
  state.list.data = [file];
  render(<HostedNativeFileManager disabled={false} />);
  expect(
    screen.getByText('Files and search: up to 100 Credits per message.'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'My AI files' }));
  expect(screen.getByText(file.name)).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: `Remove access to ${file.name}` }),
  );
  await waitFor(() =>
    expect(state.remove).toHaveBeenCalledWith(state.chat.scope, file.id),
  );
  await waitFor(() => expect(state.list.refetch).toHaveBeenCalledTimes(1));
  expect(document.body.textContent).not.toMatch(
    /deepseek|supplier cost|microUSD/i,
  );
});
it('explains that BYOK supplier usage is billed separately', () => {
  state.chat.payer = { type: 'byok', configId: 'k'.repeat(21) };
  render(<HostedNativeFileManager disabled={false} />);
  expect(
    screen.getByText(
      'Your key covers AI and web search. Your provider bills usage separately.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/up to 100/)).toBeNull();
});
