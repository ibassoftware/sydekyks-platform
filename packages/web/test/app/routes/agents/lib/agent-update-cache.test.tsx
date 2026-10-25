// @vitest-environment jsdom
import { Agent } from '@activepieces/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/features/agents/api/agents', () => ({
  agentsApi: { update: state.update },
}));
vi.mock('@/components/ui/sonner', () => ({ internalErrorToast: vi.fn() }));
vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({ checkAccess: () => true }),
}));
vi.mock('@/hooks/platform-hooks', () => ({
  platformHooks: {
    useCurrentPlatform: () => ({ platform: { plan: { agentsEnabled: true } } }),
  },
}));

import { agentsMutations } from '@/features/agents/hooks/agents-hooks';

const key = ['agents', 'one', 'agent-1', 'plain'];
const original = {
  id: 'agent-1',
  displayName: 'Original',
  updated: '2026-10-22T09:00:00.000Z',
} as Agent;
const savedA = {
  ...original,
  displayName: 'Saved A',
  updated: '2026-10-22T09:00:01.000Z',
};
const newerB = {
  ...original,
  displayName: 'Server B',
  updated: '2026-10-22T09:00:02.000Z',
};

beforeEach(() => state.update.mockReset());

describe('agent save response cache fence', () => {
  it('does not rewind a cache entry changed by another server update while a publish was pending', async () => {
    let complete!: (agent: Agent) => void;
    state.update.mockReturnValue(
      new Promise<Agent>((resolve) => {
        complete = resolve;
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(key, original);
    const { result } = renderHook(
      () => agentsMutations.useUpdateAgent({ id: original.id }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    let pending!: Promise<Agent>;
    act(() => {
      pending = result.current.mutateAsync({
        displayName: savedA.displayName,
        goLive: true,
      });
    });
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    act(() => {
      client.setQueryData(key, newerB);
    });
    await act(async () => {
      complete(savedA);
      await pending;
    });
    expect(client.getQueryData(key)).toEqual(newerB);
    client.clear();
  });

  it('applies its saved response when the cache still contains the version observed at submission', async () => {
    state.update.mockResolvedValue(savedA);
    const client = new QueryClient();
    client.setQueryData(key, original);
    const { result } = renderHook(
      () => agentsMutations.useUpdateAgent({ id: original.id }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(async () => {
      await result.current.mutateAsync({
        displayName: savedA.displayName,
        goLive: true,
      });
    });
    expect(client.getQueryData(key)).toEqual(savedA);
    client.clear();
  });
});
