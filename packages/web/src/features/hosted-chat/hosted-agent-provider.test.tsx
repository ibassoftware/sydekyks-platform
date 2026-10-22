// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  options: vi.fn(),
  session: {
    epoch: 'epoch',
    kind: 'user' as const,
    id: 'u'.repeat(21),
    platformId: 't'.repeat(21),
    expiresAt: null,
  },
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  useHostedAuthSession: () => control.session,
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getProjectId: () => 'p'.repeat(21) },
}));
vi.mock('./hosted-chat-api', () => ({
  hostedChatApi: { options: control.options },
  HostedChatError: class extends Error {
    constructor(kind: string) {
      super(kind);
    }
  },
  assertHostedChatScope: vi.fn(),
  assertHostedPayerAvailable: (
    payer: { type: 'managed' } | { type: 'byok'; configId: string } | null,
    data?: { managedAvailable: boolean; keys: { id: string }[] },
  ) => {
    if (!payer) throw new Error('selection');
    if (
      payer.type === 'managed'
        ? !data?.managedAvailable
        : !data?.keys.some((key) => key.id === payer.configId)
    )
      throw new Error(payer.type === 'byok' ? 'key' : 'unavailable');
  },
}));

import { HostedChatBoundary, useHostedChatPayer } from './hosted-chat-provider';

let chat: ReturnType<typeof useHostedChatPayer>;
function Probe() {
  chat = useHostedChatPayer();
  return null;
}
function view(props: { agentId?: string; builder?: boolean } = {}) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HostedChatBoundary {...props}>
        <Probe />
      </HostedChatBoundary>
    </QueryClientProvider>,
  );
}
const options = (
  payerLock?: { type: 'managed' } | { type: 'byok'; configId: string },
) => ({
  payerLock,
  projectId: 'p'.repeat(21),
  managedAvailable: true,
  keys: [{ id: 'k'.repeat(21), name: 'Team key' }],
  credits: { execution: { available: '100' } },
});

beforeEach(() => {
  control.options.mockReset();
  chat = null;
});
describe('native hosted Agent payer metadata', () => {
  it('uses the saved Agent payer before the first conversation is created', async () => {
    control.options.mockResolvedValue(options({ type: 'managed' }));
    view({ agentId: 'a'.repeat(21) });
    await waitFor(() => expect(chat?.ready).toBe(true));
    expect(chat?.payer).toEqual({ type: 'managed' });
    expect(control.options.mock.calls[0][0]).toMatchObject({
      agentId: 'a'.repeat(21),
      conversationId: null,
      nativeAgent: true,
      session: control.session,
    });
    await act(async () => {
      expect((await chat!.prepare()).payer).toEqual({ type: 'managed' });
    });
  });
  it('refuses a send if the Agent payer changed during metadata revalidation', async () => {
    control.options
      .mockResolvedValueOnce(options({ type: 'managed' }))
      .mockResolvedValue(options({ type: 'byok', configId: 'k'.repeat(21) }));
    view({ builder: true });
    await waitFor(() => expect(chat?.ready).toBe(true));
    await act(async () => {
      await expect(chat!.prepare()).rejects.toThrow('selection');
    });
  });
  it('keeps native runs unavailable when the server has no configuration lock', async () => {
    control.options.mockResolvedValue(options());
    view({ agentId: 'a'.repeat(21) });
    await waitFor(() => expect(chat?.loading).toBe(false));
    expect(chat?.ready).toBe(false);
    await expect(chat!.prepare()).rejects.toThrow('unavailable');
  });
});

describe('inherited hosted chat payer', () => {
  it('explains zero Credits even when managed availability and key choices are empty', async () => {
    control.options.mockResolvedValue({
      ...options(),
      managedAvailable: false,
      keys: [],
      credits: { execution: { available: '0' } },
    });
    view();
    await waitFor(() => expect(chat?.loading).toBe(false));
    expect(chat?.ready).toBe(false);
    expect(chat?.error).toMatchObject({ message: 'credits' });
    await expect(chat!.prepare()).rejects.toThrow('credits');
  });
  it('captures an explicit search choice and rejects it if access changes before send', async () => {
    control.options.mockResolvedValue({
      ...options(),
      nativeFeatures: {
        files: true,
        webSearch: true,
        maxTurnCredits: 100,
        maxFilesPerTurn: 4,
      },
    });
    view();
    await waitFor(() => expect(chat?.ready).toBe(true));
    expect(chat?.nativeWebSearch).toBe(false);
    act(() => chat!.setNativeWebSearch(true));
    await act(async () => {
      expect((await chat!.prepare()).nativeWebSearch).toBe(true);
    });
    control.options.mockResolvedValue({
      ...options(),
      nativeFeatures: {
        files: true,
        webSearch: false,
        maxTurnCredits: 100,
        maxFilesPerTurn: 4,
      },
    });
    await act(async () => {
      await expect(chat!.prepare()).rejects.toThrow('unavailable');
    });
    expect(chat?.nativeWebSearch).toBe(true);
  });
  it('inherits the configured Sydekyks default for the first root chat send', async () => {
    control.options.mockResolvedValue(options());
    view();
    await waitFor(() => expect(chat?.ready).toBe(true));
    expect(chat?.payer).toEqual({ type: 'managed' });
    await act(async () => {
      expect((await chat!.prepare()).payer).toEqual({ type: 'managed' });
    });
  });
  it('preserves an explicit BYOK choice through refresh and key revocation', async () => {
    control.options.mockResolvedValue(options());
    view();
    await waitFor(() => expect(chat?.ready).toBe(true));
    act(() => chat!.setPayer({ type: 'byok', configId: 'k'.repeat(21) }));
    await act(async () => {
      chat!.refresh();
    });
    await waitFor(() => expect(chat?.loading).toBe(false));
    expect(chat?.payer).toEqual({ type: 'byok', configId: 'k'.repeat(21) });
    control.options.mockResolvedValue({ ...options(), keys: [] });
    await act(async () => {
      chat!.refresh();
    });
    await waitFor(() => expect(chat?.ready).toBe(false));
    expect(chat?.payer).toEqual({ type: 'byok', configId: 'k'.repeat(21) });
    await expect(chat!.prepare()).rejects.toThrow('key');
  });
  it('does not default after recovering from an initial metadata error', async () => {
    control.options
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(options());
    view();
    await waitFor(() => expect(chat?.loading).toBe(false));
    await act(async () => {
      chat!.refresh();
    });
    await waitFor(() => expect(control.options).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(chat?.loading).toBe(false));
    expect(chat?.payer).toBeNull();
    expect(chat?.ready).toBe(false);
  });
  it('does not turn later managed availability into an automatic fallback', async () => {
    control.options.mockResolvedValue({
      ...options(),
      managedAvailable: false,
    });
    view();
    await waitFor(() => expect(chat?.loading).toBe(false));
    control.options.mockResolvedValue(options());
    await act(async () => {
      chat!.refresh();
    });
    await waitFor(() => expect(control.options).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(chat?.loading).toBe(false));
    expect(chat?.payer).toBeNull();
    expect(chat?.ready).toBe(false);
  });
});
