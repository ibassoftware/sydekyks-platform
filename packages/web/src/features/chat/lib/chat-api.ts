import { SeekPage } from '@activepieces/core-utils';
import {
  AgentMessageSource,
  type AgentFeedbackReason,
  type AgentHistoryMessage,
  type PersistedAgentMessage,
  AgentConversation,
  AgentRunSource,
  ConnectionOption,
  CreateAgentConversationRequest,
  GetAgentMemoryResponse,
  ImportAgentMemoryRequest,
  InstructAgentMemoryRequest,
  UpdateAgentConversationRequest,
  UpdateAgentMemoryRequest,
} from '@activepieces/shared';

import {
  hostedChatRequest,
  HostedChatSubmission,
  HostedChatScope,
  HostedChatError,
} from '@/features/hosted-chat/hosted-chat-api';
import { api } from '@/lib/api';

async function createConversation(
  request: CreateAgentConversationRequest,
  hosted?: HostedChatSubmission,
): Promise<AgentConversation> {
  const root = request.agentId || request.builder ? NATIVE_ROOT : SYD_ROOT;
  if (hosted) {
    hosted.assertCurrent();
    const conversation = await hostedChatRequest<AgentConversation>(
      hosted.scope,
      `${root}/conversations`,
      { method: 'POST', data: { ...request, projectId: hosted.projectId } },
      true,
    );
    hosted.assertCurrent();
    if (
      conversation.projectId !== hosted.projectId ||
      conversation.platformId !== hosted.scope.session.platformId ||
      conversation.userId !== hosted.scope.session.id
    )
      throw new HostedChatError('denied');
    hosted.bindConversation(conversation.id);
    conversationRoots.set(conversation.id, root);
    return conversation;
  }
  const conversation = await api.post<AgentConversation>(
    `${root}/conversations`,
    request,
  );
  conversationRoots.set(conversation.id, root);
  return conversation;
}

async function listConversations({
  cursor,
  limit = 20,
  agentId,
}: {
  cursor?: string;
  limit?: number;
  agentId?: string;
}): Promise<SeekPage<AgentConversation>> {
  const root = agentId === undefined ? SYD_ROOT : NATIVE_ROOT;
  const page = await api.get<SeekPage<AgentConversation>>(
    `${root}/conversations`,
    {
      limit,
      cursor,
      ...(agentId === undefined ? {} : { agentId }),
    },
  );
  page.data.forEach((conversation) =>
    conversationRoots.set(conversation.id, root),
  );
  return page;
}

async function getConversation(
  id: string,
  scope?: HostedChatScope,
): Promise<AgentConversation> {
  if (scope) {
    const root = hostedConversationRoot(scope);
    const conversation = await hostedChatRequest<AgentConversation>(
      scope,
      `${root}/conversations/${id}`,
      { method: 'GET' },
    );
    conversationRoots.set(id, root);
    return conversation;
  }
  const known = conversationRoots.get(id);
  if (known) return api.get<AgentConversation>(`${known}/conversations/${id}`);
  try {
    const conversation = await api.get<AgentConversation>(
      `${SYD_ROOT}/conversations/${id}`,
    );
    conversationRoots.set(id, SYD_ROOT);
    return conversation;
  } catch (error) {
    if (!api.isError(error)) throw error;
    const data = error.response?.data;
    const unavailable =
      error.response?.status === 404 ||
      (error.response?.status === 403 &&
        data !== null &&
        typeof data === 'object' &&
        'code' in data &&
        data.code === 'FEATURE_DISABLED');
    if (!unavailable) throw error;
    const conversation = await api.get<AgentConversation>(
      `${NATIVE_ROOT}/conversations/${id}`,
    );
    if (conversation.source === AgentRunSource.CHAT) throw error;
    conversationRoots.set(id, NATIVE_ROOT);
    return conversation;
  }
}

async function getMessages(
  conversationId: string,
  scope?: HostedChatScope,
): Promise<{ data: PersistedAgentMessage[] | AgentHistoryMessage[] }> {
  if (scope)
    return hostedChatRequest(
      scope,
      `${hostedConversationRoot(
        scope,
      )}/conversations/${conversationId}/messages`,
      { method: 'GET' },
    );
  return api.get<{ data: PersistedAgentMessage[] | AgentHistoryMessage[] }>(
    `${await rootForConversation(
      conversationId,
    )}/conversations/${conversationId}/messages`,
  );
}

async function updateConversation(
  id: string,
  request: UpdateAgentConversationRequest,
): Promise<AgentConversation> {
  return api.post<AgentConversation>(
    `${await rootForConversation(id)}/conversations/${id}`,
    request,
  );
}

async function deleteConversation(id: string): Promise<void> {
  return api.delete<void>(
    `${await rootForConversation(id)}/conversations/${id}`,
  );
}

async function sendMessage({
  conversationId,
  content,
  runId,
  files,
  messageSource,
  editorContext,
  hosted,
  nativeFileIds,
}: {
  hosted?: HostedChatSubmission;
  nativeFileIds?: string[];
  conversationId: string;
  content: string;
  runId?: string;
  files?: Array<{ name: string; mimeType: string; data: string }>;
  messageSource?: AgentMessageSource;
  editorContext?: {
    flowId: string;
    flowVersionId: string;
    selectedStepName?: string;
  };
}): Promise<{ conversationId: string; runId?: string }> {
  if (hosted) {
    hosted.assertCurrent();
    const result = await hostedChatRequest<{
      conversationId: string;
      runId: string;
    }>(
      hosted.scope,
      `${hostedConversationRoot(
        hosted.scope,
      )}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        data: {
          content,
          editorContext,
          messageSource,
          hostedProjectId: hosted.projectId,
          hostedPayer: hosted.payer,
          nativeWebSearch: hosted.nativeWebSearch ?? false,
          nativeFileIds,
        },
      },
      true,
    );
    hosted.assertCurrent();
    if (
      result.conversationId !== conversationId ||
      typeof result.runId !== 'string' ||
      result.runId.length !== 21
    )
      throw new HostedChatError('send');
    return result;
  }
  return api.post<{ conversationId: string; runId?: string }>(
    `${await rootForConversation(
      conversationId,
    )}/conversations/${conversationId}/messages`,
    { content, runId, files, messageSource, editorContext },
  );
}

async function approveToolCall({
  conversationId,
  gateId,
  approved,
  payload,
}: {
  conversationId?: string | null;
  gateId: string;
  approved: boolean;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const root = conversationId
    ? await rootForConversation(conversationId)
    : SYD_ROOT;
  return api.post<void>(`${root}/tool-approvals/${gateId}`, {
    approved,
    payload,
  });
}

async function cancelConversation(
  conversationId: string,
  scope?: HostedChatScope,
): Promise<void> {
  if (scope)
    return hostedChatRequest(
      scope,
      `${hostedConversationRoot(scope)}/conversations/${conversationId}/cancel`,
      { method: 'POST' },
    );
  return api.post<void>(
    `${await rootForConversation(
      conversationId,
    )}/conversations/${conversationId}/cancel`,
  );
}

async function submitMessageFeedback({
  conversationId,
  messageIndex,
  rating,
  reasons,
  comment,
}: {
  conversationId: string;
  messageIndex: number;
  rating: 'up' | 'down' | null;
  reasons?: AgentFeedbackReason[];
  comment?: string;
}): Promise<void> {
  return api.post<void>(
    `${await rootForConversation(
      conversationId,
    )}/conversations/${conversationId}/messages/${messageIndex}/feedback`,
    { rating, reasons, comment },
  );
}

async function getPickerConnections({
  conversationId,
  pieceName,
}: {
  conversationId: string;
  pieceName: string;
}): Promise<{ connections: ConnectionOption[]; reconnectOnly: boolean }> {
  return api.get(
    `${await rootForConversation(
      conversationId,
    )}/conversations/${conversationId}/connections`,
    {
      pieceName,
    },
  );
}

async function getPendingGate(
  conversationId: string,
  scope?: HostedChatScope,
): Promise<PendingGate | null> {
  if (scope)
    return hostedChatRequest(
      scope,
      `${hostedConversationRoot(
        scope,
      )}/conversations/${conversationId}/pending-gate`,
      { method: 'GET' },
    );
  return api.get(
    `${await rootForConversation(
      conversationId,
    )}/conversations/${conversationId}/pending-gate`,
  );
}

async function getMemory(): Promise<GetAgentMemoryResponse> {
  return api.get<GetAgentMemoryResponse>('/v1/syd/copilot/memory');
}

async function saveMemory(
  request: UpdateAgentMemoryRequest,
): Promise<GetAgentMemoryResponse> {
  return api.post<GetAgentMemoryResponse>('/v1/syd/copilot/memory', request);
}

async function importMemory(
  request: ImportAgentMemoryRequest,
): Promise<GetAgentMemoryResponse> {
  return api.post<GetAgentMemoryResponse>(
    '/v1/syd/copilot/memory/import',
    request,
  );
}

async function instructMemory(
  request: InstructAgentMemoryRequest,
): Promise<GetAgentMemoryResponse> {
  return api.post<GetAgentMemoryResponse>(
    '/v1/syd/copilot/memory/instruct',
    request,
  );
}

function hostedConversationRoot(scope: HostedChatScope): string {
  return scope.nativeAgent ? NATIVE_ROOT : SYD_ROOT;
}

async function rootForConversation(id: string): Promise<string> {
  const known = conversationRoots.get(id);
  if (known) return known;
  await getConversation(id);
  return conversationRoots.get(id) ?? SYD_ROOT;
}

const SYD_ROOT = '/v1/syd/copilot';
const NATIVE_ROOT = '/v1/agents';
const conversationRoots = new Map<string, string>();

export const chatApi = {
  createConversation,
  listConversations,
  getConversation,
  getMessages,
  updateConversation,
  deleteConversation,
  sendMessage,
  approveToolCall,
  cancelConversation,
  submitMessageFeedback,
  getPickerConnections,
  getPendingGate,
  getMemory,
  saveMemory,
  importMemory,
  instructMemory,
};

export type PendingGate = {
  gateId: string;
  toolName: string;
  displayName: string;
  toolInput: Record<string, unknown>;
};
