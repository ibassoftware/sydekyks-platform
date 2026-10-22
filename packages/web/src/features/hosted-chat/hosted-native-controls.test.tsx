// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-to-have-attribute, jest-dom/prefer-in-document, jest-dom/prefer-to-have-text-content -- This Vitest setup has no jest-dom matcher extension. */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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

import { FileUpload } from '@/components/prompt-kit/file-upload';
import {
  PromptInput,
  PromptInputTextarea,
} from '@/components/prompt-kit/prompt-input';

import {
  HostedAttachmentControl,
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
  expect(web.textContent).toContain('Off');
  expect(state.chat.setNativeWebSearch).not.toHaveBeenCalled();
  fireEvent.click(web);
  expect(state.chat.setNativeWebSearch).toHaveBeenCalledWith(true);
  state.chat.nativeWebSearch = true;
  view.rerender(<HostedWebSearchControl disabled />);
  expect(web.textContent).toContain('On');
  expect(web.getAttribute('aria-pressed')).toBe('true');
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
it('keeps file management under attachments and explains BYOK only when opened', async () => {
  state.chat.payer = { type: 'byok', configId: 'k'.repeat(21) };
  render(
    <FileUpload onFilesAdded={vi.fn()}>
      <PromptInput>
        <PromptInputTextarea aria-label="Chat message" />
        <HostedAttachmentControl disabled={false} uploadDisabled={false} />
      </PromptInput>
    </FileUpload>,
  );
  expect(screen.queryByText('Manage uploaded files')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Attachments' }));
  expect(
    await screen.findByText(
      'Your provider bills AI and web search separately.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/up to 100/)).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Manage uploaded files' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Manage uploaded files' }),
  ).toBeTruthy();
  expect(screen.getByText(/No active AI uploads/)).toBeTruthy();
  const fileHeading = screen.getByRole('heading', {
    name: 'Manage uploaded files',
  });
  // eslint-disable-next-line testing-library/no-node-access -- Assert the actual keyboard focus after switching popover views.
  const focusIsInFileManager = document.activeElement === fileHeading;
  expect(focusIsInFileManager).toBe(true);
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Attachments',
    }),
  );
  // eslint-disable-next-line testing-library/no-node-access -- Assert focus restoration to the upload action.
  const focusedAfterBack = document.activeElement;
  const focusReturnedToUpload =
    focusedAfterBack === screen.getByRole('button', { name: 'Attach files' });
  expect(focusReturnedToUpload).toBe(true);
});

it('allows managing existing files without Credits while upload stays disabled', async () => {
  state.chat.ready = false;
  render(
    <FileUpload disabled onFilesAdded={vi.fn()}>
      <PromptInput>
        <PromptInputTextarea aria-label="Chat message" />
        <HostedAttachmentControl disabled={false} uploadDisabled />
      </PromptInput>
    </FileUpload>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Attachments' }));
  const attach = await screen.findByRole('button', { name: 'Attach files' });
  const uploadDisabled = (attach as HTMLButtonElement).disabled;
  expect(uploadDisabled).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Manage uploaded files' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Manage uploaded files' }),
  ).toBeTruthy();
});
