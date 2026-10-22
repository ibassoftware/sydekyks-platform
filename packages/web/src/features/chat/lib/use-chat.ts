import { apId, ErrorCode, isNil, tryCatch } from '@activepieces/core-utils';
import {
  ActionPreviewEvent,
  ActionReceiptEvent,
  BuildPlanEvent,
  AgentAllowedMimeType,
  FileProducedEvent,
  ImageGeneratedEvent,
  AgentConversationStatus,
  AgentHistoryMessage,
  CHAT_ALLOWED_MIME_TYPES,
  PersistedAgentMessage,
  ToolProgressEvent,
  AgentMessageSource,
} from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  HostedChatSubmission,
  HostedChatError,
  HostedChatScope,
  assertHostedChatScope,
} from '@/features/hosted-chat/hosted-chat-api';
import { useHostedChatPayer } from '@/features/hosted-chat/hosted-chat-provider';
import { hostedNativeFilesApi } from '@/features/hosted-chat/hosted-native-files-api';
import { api } from '@/lib/api';
import { chatDebug } from '@/lib/chat-debug-logger';

import { chatApi, type PendingGate } from './chat-api';
import {
  chatBuildUtils,
  chatStoreSelectors,
  SetChatStore,
  ToolCallMeta,
} from './chat-store';
import { useChatStoreApi } from './chat-store-context';
import { ChatUIMessage, QuickRepliesData, chatPartUtils } from './chat-types';
import { chatUtils } from './chat-utils';
import { useStreamingReducer } from './use-streaming-reducer';

function applyQuickRepliesToStore({
  setState,
  data,
}: {
  setState: SetChatStore;
  data: QuickRepliesData;
}): void {
  if (data.replies.length === 0 && !data.offerRecurringAutomation) return;
  setState({
    quickReplies: data.replies,
    offerRecurringAutomation: data.offerRecurringAutomation,
  });
}

function restoreReceiptsIntoStore({
  data,
  setState,
}: {
  data: PersistedAgentMessage[] | AgentHistoryMessage[];
  setState: SetChatStore;
}): void {
  const receipts = chatUtils.extractReceiptsFromHistory(data);
  const images = chatUtils.extractImagesFromHistory(data);
  const files = chatUtils.extractFilesFromHistory(data);
  const builds = chatUtils.extractBuildsFromHistory(data);
  if (
    Object.keys(receipts).length === 0 &&
    Object.keys(images).length === 0 &&
    Object.keys(files).length === 0 &&
    Object.keys(builds).length === 0
  ) {
    return;
  }
  setState((prev) => {
    const merged = { ...prev.toolCallMeta };
    for (const [toolCallId, receipt] of Object.entries(receipts)) {
      merged[toolCallId] = { ...merged[toolCallId], actionReceipt: receipt };
    }
    for (const [toolCallId, image] of Object.entries(images)) {
      merged[toolCallId] = { ...merged[toolCallId], image };
    }
    for (const [toolCallId, toolFiles] of Object.entries(files)) {
      merged[toolCallId] = { ...merged[toolCallId], files: toolFiles };
    }
    const mergedBuilds = { ...prev.builds };
    for (const [buildId, build] of Object.entries(builds)) {
      const existing = mergedBuilds[buildId];
      if (existing && existing.updatedAt >= build.updatedAt) continue;
      mergedBuilds[buildId] = build;
    }
    return { toolCallMeta: merged, builds: mergedBuilds };
  });
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const AGENT_POLL_INTERVAL_MS = 5_000;
const TOOL_GATES_WITHOUT_A_PIECE = new Set([
  'ap_test_flow',
  'ap_delete_records',
  'ap_delete_table',
  'ap_delete_flow',
  'ap_manage_fields',
  'ap_remember',
  'ap_create_agent',
  'ap_update_agent',
  'ap_add_agent_tool',
  'ap_remove_agent_tool',
]);

function buildToolCallMetaFromGate(
  gate: PendingGate,
): Record<string, ToolCallMeta> {
  if (chatPartUtils.isDisplayTool(gate.toolName)) {
    return {};
  }
  const gateInput = gate.toolInput ?? {};
  const pieceName =
    typeof gateInput.pieceName === 'string' ? gateInput.pieceName : '';
  const actionName =
    typeof gateInput.actionName === 'string' ? gateInput.actionName : '';
  let actionPreview: ActionPreviewEvent | null = null;
  if (pieceName && actionName) {
    actionPreview = {
      toolCallId: gate.gateId,
      pieceName,
      actionName,
      actionDisplayName: gate.displayName,
      connectionLabel:
        typeof gateInput.connectionLabel === 'string'
          ? gateInput.connectionLabel
          : undefined,
      input:
        typeof gateInput.input === 'object' && gateInput.input !== null
          ? (gateInput.input as Record<string, unknown>)
          : {},
      isBatch:
        typeof gateInput.batchCount === 'number' && gateInput.batchCount > 0,
      batchCount:
        typeof gateInput.batchCount === 'number'
          ? gateInput.batchCount
          : undefined,
      batchSamples: Array.isArray(gateInput.items)
        ? (gateInput.items as Record<string, unknown>[]).slice(0, 3)
        : undefined,
    };
  } else if (TOOL_GATES_WITHOUT_A_PIECE.has(gate.toolName)) {
    actionPreview = {
      toolCallId: gate.gateId,
      pieceName: '',
      actionName: gate.toolName,
      actionDisplayName: gate.displayName,
      input: gate.toolName === 'ap_test_flow' ? {} : gateInput,
      isBatch: false,
    };
  }
  return actionPreview ? { [gate.gateId]: { actionPreview } } : {};
}

// History only persists resolved tool calls, so a live pending gate loses its `input-available`
// part on remount — without it the store selectors find no anchor and the card disappears.
function buildGatePart(gate: PendingGate) {
  return {
    type: 'dynamic-tool' as const,
    toolCallId: gate.gateId,
    toolName: gate.toolName,
    title: gate.displayName,
    state: 'input-available' as const,
    input: gate.toolInput,
  };
}

function appendGatePart({
  messages,
  gate,
}: {
  messages: ChatUIMessage[];
  gate: PendingGate;
}): ChatUIMessage[] {
  const alreadyAnchored = messages.some((m) =>
    m.parts.some(
      (part) => 'toolCallId' in part && part.toolCallId === gate.gateId,
    ),
  );
  if (alreadyAnchored) return messages;
  // Anchor on the current turn, always at the tail. When the tail is the user's just-sent
  // message (the worker is blocked on the gate before persisting its assistant turn), open a
  // fresh trailing assistant message rather than attaching to an earlier, already-finished turn.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    const next = [...messages];
    next[next.length - 1] = {
      ...last,
      parts: [...last.parts, buildGatePart(gate)],
    };
    return next;
  }
  return [
    ...messages,
    {
      id: `gate-${gate.gateId}`,
      role: 'assistant',
      parts: [buildGatePart(gate)],
    },
  ];
}

const ALLOWED_MIME_SET: ReadonlySet<string> = new Set(CHAT_ALLOWED_MIME_TYPES);

function isAllowedMimeType(value: string): value is AgentAllowedMimeType {
  return ALLOWED_MIME_SET.has(value);
}

function fileToBase64(
  file: File,
): Promise<{ name: string; mimeType: AgentAllowedMimeType; data: string }> {
  return new Promise((resolve, reject) => {
    const mimeType = file.type || 'application/octet-stream';
    if (!isAllowedMimeType(mimeType)) {
      reject(new Error(`Unsupported file type: ${mimeType}`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'));
        return;
      }
      const base64 = result.split(',')[1];
      resolve({ name: file.name, mimeType, data: base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileNamesToFileParts(fileNames: string[]): ChatUIMessage['parts'] {
  return fileNames.map((name) => ({
    type: 'file' as const,
    mediaType: 'text/plain' as const,
    url: '',
    filename: name,
  }));
}

function injectFilePartsIntoLastUserMessage({
  messages,
  fileNames,
}: {
  messages: ChatUIMessage[];
  fileNames: string[];
}): ChatUIMessage[] {
  if (fileNames.length === 0) return messages;
  const lastUserIdx = messages.findLastIndex((m) => m.role === 'user');
  if (lastUserIdx === -1) return messages;
  const lastUser = messages[lastUserIdx];
  const alreadyHasFiles = lastUser.parts.some((p) => p.type === 'file');
  if (alreadyHasFiles) return messages;
  const patched = {
    ...lastUser,
    parts: [...lastUser.parts, ...fileNamesToFileParts(fileNames)],
  };
  const result = [...messages];
  result[lastUserIdx] = patched;
  return result;
}

type SendStatus =
  | { type: 'idle' }
  | { type: 'submitting' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export function useAgentChat({
  agentId,
  builder,
  defaultModelName,
  onTitleUpdate,
  onConversationCreated,
  onCreditsExhausted,
  onTurnEnd,
  editorContext,
  onRunStateChange,
}: {
  agentId?: string;
  builder?: boolean;
  defaultModelName?: string | null;
  onTitleUpdate?: (title: string) => void;
  onConversationCreated?: (conversationId: string) => void;
  onCreditsExhausted?: () => void;
  onTurnEnd?: () => void;
  editorContext?: {
    flowId: string;
    flowVersionId: string;
    selectedStepName?: string;
  };
  onRunStateChange?: (running: boolean) => void;
} = {}) {
  const hostedChat = useHostedChatPayer();
  const hostedChatRef = useRef(hostedChat);
  hostedChatRef.current = hostedChat;
  const sendAttemptRef = useRef(0);
  useEffect(
    () => () => {
      sendAttemptRef.current++;
    },
    [],
  );
  const editorContextRef = useRef(editorContext);
  editorContextRef.current = editorContext;
  const onRunStateChangeRef = useRef(onRunStateChange);
  onRunStateChangeRef.current = onRunStateChange;
  const store = useChatStoreApi();

  const [conversationId, setConversationIdState] = useState<string | null>(
    null,
  );
  const [modelName, setModelNameState] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isPollingForAgentReply, setIsPollingForAgentReply] = useState(false);
  const [sendStatus, setSendStatus] = useState<SendStatus>({ type: 'idle' });
  const sendStatusRef = useRef<SendStatus>({ type: 'idle' });
  const onCreditsExhaustedRef = useRef(onCreditsExhausted);
  onCreditsExhaustedRef.current = onCreditsExhausted;

  const [persistedMessages, setPersistedMessages] = useState<ChatUIMessage[]>(
    [],
  );
  const persistedMessagesRef = useRef(persistedMessages);
  persistedMessagesRef.current = persistedMessages;
  const [optimisticUserMessage, setOptimisticUserMessage] =
    useState<ChatUIMessage | null>(null);
  const optimisticUserMessageRef = useRef(optimisticUserMessage);
  optimisticUserMessageRef.current = optimisticUserMessage;

  const pendingFilesRef = useRef<
    { name: string; mimeType: AgentAllowedMimeType; data: string }[] | undefined
  >(undefined);
  const lastSentFileNamesRef = useRef<string[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const modelNameRef = useRef<string | null>(null);
  const defaultModelNameRef = useRef(defaultModelName ?? null);
  defaultModelNameRef.current = defaultModelName ?? null;
  const onTitleUpdateRef = useRef(onTitleUpdate);
  onTitleUpdateRef.current = onTitleUpdate;
  const onConversationCreatedRef = useRef(onConversationCreated);
  onConversationCreatedRef.current = onConversationCreated;

  const readIsCurrent = useCallback(
    (convId: string, attempt: number, scope?: HostedChatScope) => {
      if (conversationIdRef.current !== convId) return false;
      if (!scope) return true;
      try {
        assertHostedChatScope(scope);
      } catch {
        return false;
      }
      const current = hostedChatRef.current?.scope;
      return (
        attempt === sendAttemptRef.current &&
        current?.session === scope.session &&
        current?.projectPointer === scope.projectPointer &&
        (current.conversationId === convId ||
          (current.conversationId === null && scope.conversationId === null))
      );
    },
    [],
  );

  const handleTitleUpdate = useCallback((title: string) => {
    onTitleUpdateRef.current?.(title);
  }, []);

  const handleToolProgress = useCallback(
    (event: ToolProgressEvent) => {
      store.setState((prev) => {
        const existing = prev.toolCallMeta[event.toolCallId]?.batchProgress;
        if (
          existing &&
          existing.completed === event.data.completed &&
          existing.done === event.data.done
        ) {
          return prev;
        }
        return {
          toolCallMeta: {
            ...prev.toolCallMeta,
            [event.toolCallId]: {
              ...prev.toolCallMeta[event.toolCallId],
              batchProgress: event.data,
            },
          },
        };
      });
    },
    [store],
  );

  const updateToolCallMeta = useCallback(
    <K extends keyof ToolCallMeta>(
      key: K,
      event: ToolCallMeta[K] & { toolCallId: string },
    ) => {
      store.setState((prev) => ({
        toolCallMeta: {
          ...prev.toolCallMeta,
          [event.toolCallId]: {
            ...prev.toolCallMeta[event.toolCallId],
            [key]: event,
          },
        },
      }));
    },
    [store],
  );

  const handleActionPreview = useCallback(
    (event: ActionPreviewEvent) => {
      updateToolCallMeta('actionPreview', event);
    },
    [updateToolCallMeta],
  );

  const handleActionReceipt = useCallback(
    (event: ActionReceiptEvent) => {
      updateToolCallMeta('actionReceipt', event);
    },
    [updateToolCallMeta],
  );

  const handleImageGenerated = useCallback(
    (event: ImageGeneratedEvent) => {
      updateToolCallMeta('image', event);
    },
    [updateToolCallMeta],
  );

  const handleFileProduced = useCallback(
    (event: FileProducedEvent) => {
      store.setState((prev) => {
        const existing = prev.toolCallMeta[event.toolCallId]?.files ?? [];
        if (existing.some((file) => file.fileId === event.fileId)) return prev;
        return {
          toolCallMeta: {
            ...prev.toolCallMeta,
            [event.toolCallId]: {
              ...prev.toolCallMeta[event.toolCallId],
              files: [...existing, event],
            },
          },
        };
      });
    },
    [store],
  );

  const handleBuildPlan = useCallback(
    (event: BuildPlanEvent) => {
      store.setState((prev) => {
        const builds = chatBuildUtils.mergeBuildPlan({
          builds: prev.builds,
          event,
        });
        if (builds === prev.builds) return prev;
        return { builds };
      });
    },
    [store],
  );

  const updateSendStatus = useCallback((next: SendStatus) => {
    sendStatusRef.current = next;
    setSendStatus(next);
  }, []);

  const reconcile = useCallback(
    async (convId: string): Promise<ChatUIMessage[] | null> => {
      if (conversationIdRef.current !== convId) return null;
      const scope = hostedChatRef.current?.scope;
      const attempt = sendAttemptRef.current;
      const { data: result } = await tryCatch(() =>
        chatApi.getMessages(convId, scope),
      );
      if (!readIsCurrent(convId, attempt, scope)) return null;
      if (!result) return null;
      const mapped = chatUtils.mapHistoryToUIMessages(result.data);
      setPersistedMessages(mapped);
      const restored = chatUtils.extractQuickRepliesFromHistory(mapped);
      applyQuickRepliesToStore({ setState: store.setState, data: restored });
      restoreReceiptsIntoStore({
        data: result.data,
        setState: store.setState,
      });
      return mapped;
    },
    [store, readIsCurrent],
  );

  const settleStreamRef = useRef<
    (
      convId: string,
      opts?: { errorMessage?: string; suppressNoReply?: boolean },
    ) => void
  >(() => {});

  const {
    streamingMessage,
    streamPhase,
    streamError,
    streamGeneration,
    isResumedStream,
    startStream,
    setActiveRunId,
    stopStream,
    clearStreamingState,
  } = useStreamingReducer({
    onTitleUpdate: handleTitleUpdate,
    onToolProgress: handleToolProgress,
    onActionPreview: handleActionPreview,
    onActionReceipt: handleActionReceipt,
    onImageGenerated: handleImageGenerated,
    onFileProduced: handleFileProduced,
    onBuildPlan: handleBuildPlan,
    onStreamFinished: (convId) => {
      chatDebug.info({ conversation: { id: convId } }, 'stream finished');
      settleStreamRef.current(convId);
    },
    onStreamError: ({ conversationId: convId, errorCode, errorMessage }) => {
      chatDebug.error(
        { conversation: { id: convId }, errorCode, error: errorMessage },
        'stream error',
      );
      if (errorCode === ErrorCode.QUOTA_EXCEEDED) {
        onCreditsExhaustedRef.current?.();
        settleStreamRef.current(convId, { suppressNoReply: true });
        return;
      }
      settleStreamRef.current(convId, { errorMessage });
    },
    onStaleCheck: (convId) => {
      void tryCatch(async () => {
        const scope = hostedChatRef.current?.scope;
        const attempt = sendAttemptRef.current;
        const conv = await chatApi.getConversation(convId, scope);
        if (isNil(conv) || !readIsCurrent(convId, attempt, scope)) return;

        if (conv.status !== AgentConversationStatus.STREAMING) {
          settleStreamRef.current(convId);
        }
      });
    },
  });

  // Settles a stream once the run ends. Reconciles server history into the view,
  // but never wipes the user's message on an empty reconcile (e.g. the worker
  // never ran), and surfaces an error — explicit, or a "no response" fallback
  // when the run ended without an assistant reply — instead of blanking the panel.
  settleStreamRef.current = (convId, opts) => {
    const gen = streamGeneration.current;
    const scope = hostedChatRef.current?.scope;
    const attempt = sendAttemptRef.current;
    void reconcile(convId).then((mapped) => {
      if (
        !readIsCurrent(convId, attempt, scope) ||
        (scope && gen !== streamGeneration.current)
      )
        return;
      // Defense-in-depth: a settled turn's history should only ever grow (it now
      // includes the just-finished reply). Refuse a strictly-shorter reconcile so
      // a transient server hiccup can never collapse the visible conversation.
      const isShrink =
        mapped !== null && mapped.length < persistedMessagesRef.current.length;
      const history = mapped && mapped.length > 0 && !isShrink ? mapped : null;
      if (history) {
        setPersistedMessages(history);
        setOptimisticUserMessage(null);
      }
      const hasReply =
        history !== null &&
        history.findLastIndex((m) => m.role === 'assistant') >
          history.findLastIndex((m) => m.role === 'user');
      if (opts?.errorMessage) {
        const lastReply = history?.at(-1);
        const failureIsInTranscript =
          lastReply?.role === 'assistant' &&
          lastReply.parts.some(
            (part) => part.type === 'text' && part.text === opts.errorMessage,
          );
        updateSendStatus({
          type: 'error',
          message: failureIsInTranscript
            ? t('The last reply did not finish. Please try again.')
            : opts.errorMessage,
        });
      } else if (!hasReply && !opts?.suppressNoReply) {
        updateSendStatus({
          type: 'error',
          message: t('The assistant did not respond. Please try again.'),
        });
      }
      clearStreamingState(gen);
    });
  };

  const streamingQuickReplies = useMemo(
    () => chatPartUtils.extractQuickRepliesFromParts(streamingMessage),
    [streamingMessage],
  );

  useEffect(() => {
    applyQuickRepliesToStore({
      setState: store.setState,
      data: streamingQuickReplies,
    });
  }, [streamingQuickReplies, store]);

  const isStreamActive = streamPhase !== 'idle';
  const onTurnEndRef = useRef(onTurnEnd);
  onTurnEndRef.current = onTurnEnd;
  const wasStreamActiveRef = useRef(false);
  useEffect(() => {
    if (wasStreamActiveRef.current && !isStreamActive) {
      onTurnEndRef.current?.();
    }
    wasStreamActiveRef.current = isStreamActive;
  }, [isStreamActive]);

  const isStreaming =
    isStreamActive ||
    sendStatusRef.current.type === 'submitting' ||
    isPollingForAgentReply;

  useEffect(() => {
    onRunStateChangeRef.current?.(isStreaming);
    return () => onRunStateChangeRef.current?.(false);
  }, [isStreaming]);

  const isAwaitingResponse =
    streamPhase === 'awaiting-stream' ||
    streamPhase === 'streaming' ||
    sendStatus.type === 'submitting';

  const messages: ChatUIMessage[] = useMemo(() => {
    const base = [...persistedMessages];
    if (optimisticUserMessage) base.push(optimisticUserMessage);
    if (streamingMessage) base.push(streamingMessage);
    return injectFilePartsIntoLastUserMessage({
      messages: base,
      fileNames: lastSentFileNamesRef.current,
    });
  }, [persistedMessages, optimisticUserMessage, streamingMessage]);

  const error =
    sendStatus.type === 'error'
      ? sendStatus.message
      : streamError
      ? streamError
      : null;

  const wasCancelled = sendStatus.type === 'cancelled';

  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;

  // Folds the in-flight turn (optimistic user message + live streaming assistant)
  // into persisted history so it stays painted continuously when the turn is
  // preempted or cancelled — otherwise both halves live only in ephemeral state
  // and vanish until the next end-of-turn reconcile. Deduped by id so it can
  // never double-add; the reconcile later replaces persisted with authoritative
  // server history.
  const commitInFlightTurn = useCallback(() => {
    const inflightUser = optimisticUserMessageRef.current;
    const inflightStreaming = streamingMessageRef.current;
    const hasStreaming =
      !!inflightStreaming && inflightStreaming.parts.length > 0;
    if (!inflightUser && !hasStreaming) return;
    setPersistedMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const additions: ChatUIMessage[] = [];
      if (inflightUser && !existingIds.has(inflightUser.id)) {
        additions.push(inflightUser);
      }
      if (
        hasStreaming &&
        inflightStreaming &&
        !existingIds.has(inflightStreaming.id)
      ) {
        additions.push(inflightStreaming);
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, []);

  const cancelStream = useCallback(() => {
    sendAttemptRef.current++;
    commitInFlightTurn();
    stopStream();
    setOptimisticUserMessage(null);
    setIsPollingForAgentReply(false);
    updateSendStatus({ type: 'cancelled' });
    const convId = conversationIdRef.current;
    if (convId) {
      void tryCatch(() =>
        chatApi.cancelConversation(convId, hostedChatRef.current?.scope),
      );
    }
  }, [commitInFlightTurn, stopStream, updateSendStatus]);

  const createConversation = useCallback(
    async ({
      title,
      modelName,
      hosted,
    }: {
      title?: string | null;
      modelName?: string | null;
      hosted?: HostedChatSubmission;
    } = {}) => {
      const conv = await chatApi.createConversation(
        {
          title: title ?? null,
          modelName: modelName ?? null,
          ...(agentId === undefined ? {} : { agentId }),
          ...(builder === undefined ? {} : { builder }),
        },
        hosted,
      );
      hosted?.assertCurrent();
      conversationIdRef.current = conv.id;
      setConversationIdState(conv.id);
      return conv;
    },
    [agentId, builder],
  );

  const sendMessage = useCallback(
    async (
      content: string,
      files?: File[],
      options?: { messageSource?: AgentMessageSource },
    ) => {
      const hostedChat = hostedChatRef.current;
      if (hostedChat && sendStatusRef.current.type === 'submitting') return;
      const attempt = ++sendAttemptRef.current;
      updateSendStatus({ type: 'submitting' });
      if (hostedChat) setIsLoadingHistory(false);
      let hosted: HostedChatSubmission | undefined;
      let nativeFileIds: string[] | undefined;
      if (hostedChat) {
        const prepared = await tryCatch(() => hostedChat.prepare());
        if (attempt !== sendAttemptRef.current) return;
        if (prepared.error || !prepared.data) {
          updateSendStatus({
            type: 'error',
            message: prepared.error?.message ?? 'Chat billing is unavailable.',
          });
          return;
        }
        const captured = prepared.data;
        hosted = {
          ...captured,
          assertCurrent: () => {
            captured.assertCurrent();
            if (attempt !== sendAttemptRef.current)
              throw new HostedChatError('session');
          },
        };
      }

      const fileNames = files?.map((f) => f.name) ?? [];
      lastSentFileNamesRef.current = fileNames;

      const optimisticUser: ChatUIMessage = {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        parts: [
          { type: 'text', text: content },
          ...fileNamesToFileParts(fileNames),
        ],
      };

      // Preempting an in-flight turn: keep its messages on screen by folding them
      // into persisted history before they get overwritten/reset below, then clear
      // the live stream so it isn't shown twice during the send.
      commitInFlightTurn();
      stopStream();
      setOptimisticUserMessage(optimisticUser);
      store.getState().resetInteractions();

      if (hosted && files?.length) {
        const uploaded = await tryCatch(() =>
          hostedNativeFilesApi.upload(hosted!, files),
        );
        if (attempt !== sendAttemptRef.current) return;
        if (uploaded.error || !uploaded.data) {
          setOptimisticUserMessage(null);
          updateSendStatus({
            type: 'error',
            message:
              uploaded.error?.message ??
              'The files could not be prepared. Attach them again.',
          });
          return;
        }
        nativeFileIds = uploaded.data.map((file) => file.id);
        pendingFilesRef.current = undefined;
      } else if (files && files.length > 0) {
        const oversized = files.find((f) => f.size > MAX_FILE_SIZE);
        if (oversized) {
          setOptimisticUserMessage(null);
          updateSendStatus({
            type: 'error',
            message: `File "${oversized.name}" exceeds 10 MB limit`,
          });
          return;
        }
        const { data: encodedFiles, error: fileError } = await tryCatch(
          async () => Promise.all(files.map(fileToBase64)),
        );
        if (fileError) {
          setOptimisticUserMessage(null);
          updateSendStatus({
            type: 'error',
            message: fileError.message ?? 'Failed to read attached files',
          });
          return;
        }
        pendingFilesRef.current = encodedFiles;
      } else {
        pendingFilesRef.current = undefined;
      }

      if (!conversationIdRef.current) {
        const { error: convError } = await tryCatch(async () => {
          const conv = await createConversation({
            title: content.slice(0, 100),
            modelName: modelNameRef.current ?? defaultModelNameRef.current,
            hosted,
          });
          onConversationCreatedRef.current?.(conv.id);
        });
        if (hostedChat && attempt !== sendAttemptRef.current) return;
        if (convError) {
          setOptimisticUserMessage(null);
          updateSendStatus({
            type: 'error',
            message: convError.message ?? 'Failed to start conversation',
          });
          return;
        }
        if (sendStatusRef.current.type === 'cancelled') {
          setOptimisticUserMessage(null);
          return;
        }
      }

      const convId = conversationIdRef.current;
      if (!convId) {
        setOptimisticUserMessage(null);
        updateSendStatus({
          type: 'error',
          message: 'No conversation ID',
        });
        return;
      }

      const runId = apId();
      startStream(convId, hosted ? { awaitRunId: true } : undefined);
      if (!hosted) setActiveRunId(runId);
      if (!hosted) updateSendStatus({ type: 'idle' });
      chatDebug.info(
        {
          conversation: { id: convId },
          run: { id: runId },
          contentLength: content.length,
          filesCount: pendingFilesRef.current?.length ?? 0,
        },
        'sending chat message',
      );

      const { data: sent, error: sendError } = await tryCatch(async () =>
        chatApi.sendMessage({
          conversationId: convId,
          hosted,
          content,
          runId,
          editorContext: editorContextRef.current,
          files: pendingFilesRef.current,
          nativeFileIds,
          ...(options?.messageSource
            ? { messageSource: options.messageSource }
            : {}),
        }),
      );
      if (hostedChat && attempt !== sendAttemptRef.current) return;
      if (hosted && sent?.runId) setActiveRunId(sent.runId);
      if (hosted) updateSendStatus({ type: 'idle' });
      if (sendError) {
        chatDebug.error(
          {
            conversation: { id: convId },
            run: { id: runId },
            error: sendError.message,
          },
          'chat message send failed',
        );
        stopStream();
        setOptimisticUserMessage(null);
        if (api.isApError(sendError, ErrorCode.QUOTA_EXCEEDED)) {
          onCreditsExhaustedRef.current?.();
          updateSendStatus({ type: 'idle' });
        } else {
          updateSendStatus({
            type: 'error',
            message: sendError.message ?? 'Failed to send message',
          });
        }
      }
    },
    [
      createConversation,
      startStream,
      setActiveRunId,
      stopStream,
      updateSendStatus,
      commitInFlightTurn,
      store,
    ],
  );

  const setConversationId = useCallback(
    async (id: string) => {
      if (
        chatUtils.reopensSameConversation({
          current: conversationIdRef.current,
          next: id,
        })
      )
        return;
      sendAttemptRef.current++;
      stopStream();
      setIsPollingForAgentReply(false);
      updateSendStatus({ type: 'idle' });
      conversationIdRef.current = id;
      setConversationIdState(id);
      store.getState().resetInteractions();
      store.getState().resetBuilds();

      pendingFilesRef.current = undefined;
      lastSentFileNamesRef.current = [];
      setOptimisticUserMessage(null);

      setIsLoadingHistory(true);
      const scope = hostedChatRef.current?.scope;
      const attempt = sendAttemptRef.current;
      const [historyResult, convResult] = await Promise.all([
        tryCatch(async () => chatApi.getMessages(id, scope)),
        tryCatch(async () => chatApi.getConversation(id, scope)),
      ]);
      if (!readIsCurrent(id, attempt, scope)) return;
      if (historyResult.error || convResult.error) {
        conversationIdRef.current = null;
        setConversationIdState(null);
        setIsLoadingHistory(false);
        updateSendStatus({
          type: 'error',
          message: 'Conversation not found',
        });
        return;
      }
      const mapped = chatUtils.mapHistoryToUIMessages(historyResult.data.data);
      if (
        scope &&
        convResult.data.status === AgentConversationStatus.STREAMING &&
        !convResult.data.activeRunId
      ) {
        setPersistedMessages(mapped);
        setIsLoadingHistory(false);
        updateSendStatus({
          type: 'error',
          message:
            'The active run could not be verified. Refresh the conversation before sending again.',
        });
        return;
      }
      const restored = chatUtils.extractQuickRepliesFromHistory(mapped);
      applyQuickRepliesToStore({ setState: store.setState, data: restored });
      restoreReceiptsIntoStore({
        data: historyResult.data.data,
        setState: store.setState,
      });
      modelNameRef.current = convResult.data.modelName ?? null;
      setModelNameState(convResult.data.modelName ?? null);
      if (convResult.data.status === AgentConversationStatus.STREAMING) {
        const lastAssistantIdx = mapped.findLastIndex(
          (m) => m.role === 'assistant',
        );
        const lastUserIdx = mapped.findLastIndex((m) => m.role === 'user');
        const isCurrentStreamingResponse =
          lastAssistantIdx >= 0 && lastAssistantIdx > lastUserIdx;
        if (isCurrentStreamingResponse) {
          setPersistedMessages(mapped.slice(0, lastAssistantIdx));
        } else {
          setPersistedMessages(mapped);
        }
        const { data: gate } = await tryCatch(() =>
          chatApi.getPendingGate(id, scope),
        );
        if (!readIsCurrent(id, attempt, scope)) return;
        const baseParts = isCurrentStreamingResponse
          ? mapped[lastAssistantIdx].parts
          : undefined;
        const gatePart = gate ? buildGatePart(gate) : undefined;
        startStream(id, {
          initialParts: gatePart ? [...(baseParts ?? []), gatePart] : baseParts,
          ...(hostedChatRef.current && convResult.data.activeRunId
            ? { runId: convResult.data.activeRunId }
            : {}),
        });
        if (gate) {
          store.setState((prev) => ({
            toolCallMeta: {
              ...prev.toolCallMeta,
              ...buildToolCallMetaFromGate(gate),
            },
          }));
        }
      } else {
        setPersistedMessages(mapped);
        if (convResult.data.status === AgentConversationStatus.ERROR) {
          updateSendStatus({
            type: 'error',
            message: t('The last reply did not finish. Please try again.'),
          });
        }
      }
      setIsLoadingHistory(false);
    },
    [stopStream, startStream, updateSendStatus, store, readIsCurrent],
  );

  useQuery({
    queryKey: hostedChat
      ? [
          'hosted-chat-poll',
          hostedChat.scope.session.epoch,
          hostedChat.scope.session.platformId,
          hostedChat.scope.session.id,
          hostedChat.scope.projectPointer,
          conversationId,
        ]
      : ['chat-agent-poll', conversationId],
    ...(hostedChat ? { retry: false, gcTime: 0 } : {}),
    queryFn: async () => {
      if (!conversationId || conversationIdRef.current !== conversationId)
        return null;
      const scope = hostedChatRef.current?.scope;
      const attempt = sendAttemptRef.current;
      const [messagesResult, convResult] = await Promise.all([
        chatApi.getMessages(conversationId, scope),
        chatApi.getConversation(conversationId, scope),
      ]);
      if (!readIsCurrent(conversationId, attempt, scope)) return null;
      const mapped = chatUtils.mapHistoryToUIMessages(messagesResult.data);
      const current = persistedMessagesRef.current;
      // Never let a poll shrink the visible history — only apply growth or
      // in-place part updates, never a truncation.
      const hasChanged =
        mapped.length >= current.length &&
        (mapped.length !== current.length ||
          mapped.some((m, i) => m.parts.length !== current[i]?.parts.length));
      if (hasChanged) {
        setPersistedMessages(mapped);
        const restored = chatUtils.extractQuickRepliesFromHistory(mapped);
        applyQuickRepliesToStore({ setState: store.setState, data: restored });
      }
      if (convResult.status !== AgentConversationStatus.STREAMING) {
        setIsPollingForAgentReply(false);
      } else {
        const hasBlockingCard = chatStoreSelectors.hasBlockingCard({
          state: store.getState(),
          lastAssistantMessage: mapped[mapped.length - 1],
        });
        if (!hasBlockingCard) {
          const { data: gate } = await tryCatch(() =>
            chatApi.getPendingGate(conversationId, scope),
          );
          if (gate && readIsCurrent(conversationId, attempt, scope)) {
            store.setState((prev) => ({
              toolCallMeta: {
                ...prev.toolCallMeta,
                ...buildToolCallMetaFromGate(gate),
              },
            }));
            setPersistedMessages((prev) =>
              appendGatePart({ messages: prev, gate }),
            );
          }
        }
      }
      return mapped;
    },
    enabled: isPollingForAgentReply && !isStreamActive && !hostedChat?.denied,
    refetchInterval: AGENT_POLL_INTERVAL_MS,
  });

  const setModelName = useCallback(async (newModelName: string) => {
    modelNameRef.current = newModelName;
    setModelNameState(newModelName);
    const convId = conversationIdRef.current;
    if (convId) {
      await chatApi
        .updateConversation(convId, { modelName: newModelName })
        .catch(() => undefined);
    }
  }, []);

  return {
    conversationId,
    modelName,
    messages,
    isStreaming,
    isResumedStream,
    isAwaitingResponse,
    wasCancelled,
    isLoadingHistory,
    error,
    sendMessage,
    cancelStream,
    setConversationId,
    setModelName,
  };
}
