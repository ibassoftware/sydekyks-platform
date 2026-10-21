// @vitest-environment jsdom
import { AgentRunSource } from '@activepieces/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatApi } from '@/features/chat/lib/chat-api';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    isError: (e: unknown) =>
      typeof e === 'object' && e !== null && 'response' in e,
  },
}));
beforeEach(() => vi.clearAllMocks());

describe('Syd and saved-agent API routing', () => {
  it('sends new CHAT to Syd and agent/builder requests to their existing routes', async () => {
    vi.mocked(api.post).mockResolvedValue({ id: 'created' });
    await chatApi.createConversation({});
    expect(api.post).toHaveBeenLastCalledWith(
      '/v1/syd/copilot/conversations',
      {},
    );
    await chatApi.createConversation({ agentId: 'saved' });
    expect(api.post).toHaveBeenLastCalledWith('/v1/agents/conversations', {
      agentId: 'saved',
    });
    await chatApi.createConversation({ builder: true });
    expect(api.post).toHaveBeenLastCalledWith('/v1/agents/conversations', {
      builder: true,
    });
  });
  it('opens a cold-cache saved-agent ID when CHAT is disabled and routes approval correctly', async () => {
    vi.mocked(api.get)
      .mockRejectedValueOnce({
        response: { status: 403, data: { code: 'FEATURE_DISABLED' } },
      })
      .mockResolvedValueOnce({
        id: 'cold-saved',
        source: AgentRunSource.AGENT,
      });
    await chatApi.getConversation('cold-saved');
    await chatApi.approveToolCall({
      conversationId: 'cold-saved',
      gateId: 'gate',
      approved: true,
    });
    expect(api.post).toHaveBeenCalledWith('/v1/agents/tool-approvals/gate', {
      approved: true,
      payload: undefined,
    });
  });
  it('does not resurrect migrated CHAT rows through native fallback', async () => {
    const missing = { response: { status: 404 } };
    vi.mocked(api.get)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ id: 'deleted', source: AgentRunSource.CHAT });
    await expect(chatApi.getConversation('deleted')).rejects.toEqual(missing);
  });
  it('does not fall back for authorization errors', async () => {
    vi.mocked(api.get).mockRejectedValueOnce({
      response: { status: 403, data: { code: 'AUTHORIZATION' } },
    });
    await expect(chatApi.getConversation('denied')).rejects.toBeDefined();
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it('routes CHAT history, cancellation and memory to Syd', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ id: 'chat-row', source: AgentRunSource.CHAT })
      .mockResolvedValue({ data: [] });
    await chatApi.getMessages('chat-row');
    expect(api.get).toHaveBeenLastCalledWith(
      '/v1/syd/copilot/conversations/chat-row/messages',
    );
    await chatApi.cancelConversation('chat-row');
    expect(api.post).toHaveBeenLastCalledWith(
      '/v1/syd/copilot/conversations/chat-row/cancel',
    );
    await chatApi.getMemory();
    expect(api.get).toHaveBeenLastCalledWith('/v1/syd/copilot/memory');
  });
});
