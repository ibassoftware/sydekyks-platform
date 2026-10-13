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

import { api } from '@/lib/api';

async function createConversation(
  request: CreateAgentConversationRequest,
): Promise<AgentConversation> {
  const root = request.agentId || request.builder ? NATIVE_ROOT : SYD_ROOT;
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

async function getConversation(id: string): Promise<AgentConversation> {
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
): Promise<{ data: PersistedAgentMessage[] | AgentHistoryMessage[] }> {
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
}: {
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

async function cancelConversation(conversationId: string): Promise<void> {
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
): Promise<PendingGate | null> {
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
