import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/features/hosted-chat/hosted-chat-api', () => ({
  hostedChatRequest: control.request,
  HostedChatError: class extends Error {},
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

import { chatApi } from '@/features/chat/lib/chat-api';
import type {
  HostedChatScope,
  HostedChatSubmission,
} from '@/features/hosted-chat/hosted-chat-api';

const id = 'c'.repeat(21);
const projectId = 'p'.repeat(21);
const scope: HostedChatScope = {
  session: {
    epoch: 'session',
    kind: 'user',
    id: 'u'.repeat(21),
    platformId: 't'.repeat(21),
    expiresAt: null,
  },
  projectPointer: projectId,
  conversationId: id,
  nativeAgent: true,
  agentId: 'a'.repeat(21),
};
const submission = (): HostedChatSubmission => ({
  scope,
  projectId,
  payer: { type: 'managed' },
  assertCurrent: vi.fn(),
  bindConversation: vi.fn(),
});

beforeEach(() => control.request.mockReset());

describe('hosted saved Agent routing', () => {
  it('creates Agent and design conversations through native routes with the captured session', async () => {
    control.request.mockResolvedValue({
      id,
      projectId,
      platformId: scope.session.platformId,
      userId: scope.session.id,
    });
    for (const request of [{ agentId: 'a'.repeat(21) }, { builder: true }]) {
      const hosted = submission();
      await chatApi.createConversation(request, hosted);
      expect(control.request).toHaveBeenLastCalledWith(
        scope,
        '/v1/agents/conversations',
        { method: 'POST', data: { ...request, projectId } },
        true,
      );
      expect(hosted.bindConversation).toHaveBeenCalledWith(id);
    }
  });

  it('keeps cold native history, sends, cancellation and gates on the same scoped root', async () => {
    control.request.mockResolvedValue({
      conversationId: id,
      runId: 'r'.repeat(21),
    });
    await chatApi.getConversation(id, scope);
    expect(control.request).toHaveBeenLastCalledWith(
      scope,
      `/v1/agents/conversations/${id}`,
      { method: 'GET' },
    );
    await chatApi.getMessages(id, scope);
    expect(control.request).toHaveBeenLastCalledWith(
      scope,
      `/v1/agents/conversations/${id}/messages`,
      { method: 'GET' },
    );
    await chatApi.sendMessage({
      conversationId: id,
      content: 'Hello',
      hosted: submission(),
    });
    expect(control.request.mock.lastCall?.[1]).toBe(
      `/v1/agents/conversations/${id}/messages`,
    );
    await chatApi.cancelConversation(id, scope);
    expect(control.request).toHaveBeenLastCalledWith(
      scope,
      `/v1/agents/conversations/${id}/cancel`,
      { method: 'POST' },
    );
    await chatApi.getPendingGate(id, scope);
    expect(control.request).toHaveBeenLastCalledWith(
      scope,
      `/v1/agents/conversations/${id}/pending-gate`,
      { method: 'GET' },
    );
  });

  it('keeps workspace chat on Syd and rejects mismatched creation ownership', async () => {
    const hosted = submission();
    control.request.mockResolvedValue({
      id,
      projectId,
      platformId: 'wrong',
      userId: scope.session.id,
    });
    await expect(chatApi.createConversation({}, hosted)).rejects.toBeDefined();
    expect(control.request.mock.lastCall?.[1]).toBe(
      '/v1/syd/copilot/conversations',
    );
    expect(hosted.bindConversation).not.toHaveBeenCalled();
    control.request.mockResolvedValue({ id });
    await chatApi.getConversation(id, { ...scope, nativeAgent: false });
    expect(control.request.mock.lastCall?.[1]).toBe(
      `/v1/syd/copilot/conversations/${id}`,
    );
  });
});
