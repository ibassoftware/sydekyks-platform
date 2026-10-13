import { tryCatch } from '@activepieces/core-utils';
import { flowStructureUtil } from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { MessageSquarePlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AIChatBox } from '@/app/routes/chat-with-ai/ai-chat-box';
import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Button } from '@/components/ui/button';
import { flowsApi } from '@/features/flows/api/flows-api';
import { authenticationSession } from '@/lib/authentication-session';

import { useBuilderStateContext, useBuilderStore } from './builder-hooks';

export function BuilderCopilot({ onClose }: { onClose: () => void }) {
  const store = useBuilderStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [version, selectedStep, saving] = useBuilderStateContext((state) => [
    state.flowVersion,
    state.selectedStep,
    state.saving || state.pendingDebouncedUpdates,
  ]);
  const storageKey = `syd-flow-chat:${authenticationSession.getCurrentUserId()}:${
    version.flowId
  }`;
  const [conversationId, setConversationId] = useState<string | null>(
    () =>
      searchParams.get('conversation') ?? sessionStorage.getItem(storageKey),
  );
  const [conversationGeneration, setConversationGeneration] = useState(0);
  const [running, setRunning] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const previousReadonly = useRef<boolean | null>(null);
  const runGeneration = useRef(0);

  const synchronizeFlow = useCallback(async () => {
    const { data: flow, error } = await tryCatch(() =>
      flowsApi.get(version.flowId),
    );
    setRefreshError(Boolean(error));
    if (!flow) return null;
    const state = store.getState();
    if (
      state.saving ||
      state.isPublishing ||
      state.flowVersion.flowId !== flow.id ||
      state.flowVersion.updated === flow.version.updated
    )
      return flow;
    const selected = state.selectedStep;
    const sidebar = state.rightSidebar;
    state.setFlow(flow);
    state.setVersion(flow.version, false);
    if (previousReadonly.current !== null) store.getState().setReadOnly(true);
    if (selected && flowStructureUtil.getStep(selected, flow.version.trigger))
      state.selectStepByName(selected);
    store.getState().setRightSidebar(sidebar);
    store.getState().incrementCopilotRevision();
    return flow;
  }, [store, version.flowId]);

  useQuery({
    queryKey: ['builder-copilot-refresh', version.flowId],
    queryFn: synchronizeFlow,
    enabled: running,
    refetchInterval: running ? 1500 : false,
    retry: false,
  });

  const handleRunState = useCallback(
    (active: boolean) => {
      setRunning(active);
      const generation = ++runGeneration.current;
      const state = store.getState();
      if (active) state.setCopilotRunning(true);
      if (active && previousReadonly.current === null) {
        previousReadonly.current = state.readonly;
        state.setReadOnly(true);
      } else if (!active && previousReadonly.current !== null) {
        void synchronizeFlow().then((flow) => {
          if (!flow) return;
          if (
            generation !== runGeneration.current ||
            previousReadonly.current === null
          )
            return;
          store
            .getState()
            .setReadOnly(
              previousReadonly.current || store.getState().isPublishing,
            );
          previousReadonly.current = null;
          store.getState().setCopilotRunning(false);
        });
      }
    },
    [store, synchronizeFlow],
  );

  useEffect(
    () => () => {
      runGeneration.current++;
      store.getState().setCopilotRunning(false);
      if (previousReadonly.current !== null)
        store.getState().setReadOnly(previousReadonly.current);
    },
    [store],
  );

  const beforeSend = () => {
    if (
      store.getState().saving ||
      store.getState().pendingDebouncedUpdates ||
      refreshError
    )
      return false;
    handleRunState(true);
    return true;
  };

  const newConversation = () => {
    sessionStorage.removeItem(storageKey);
    setConversationId(null);
    setConversationGeneration((value) => value + 1);
    const next = new URLSearchParams(searchParams);
    next.delete('conversation');
    setSearchParams(next, { replace: true });
  };

  const rememberConversation = (id: string) => {
    sessionStorage.setItem(storageKey, id);
    setConversationId(id);
  };

  const contextLabel = `${version.displayName}${
    selectedStep
      ? ` · ${
          flowStructureUtil.getStep(selectedStep, version.trigger)
            ?.displayName ?? ''
        }`
      : ''
  }`;

  return (
    <section
      aria-label={t('Mission copilot')}
      className="flex h-full min-h-0 flex-col bg-panel"
    >
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{t('Ask Syd')}</h2>
          <TextWithTooltip tooltipMessage={contextLabel}>
            <p className="truncate text-xs text-gray-11">{contextLabel}</p>
          </TextWithTooltip>
        </div>
        <div className="flex shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('New chat')}
            disabled={running}
            onClick={newConversation}
          >
            <MessageSquarePlus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('Close chat')}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {refreshError && (
        <div role="alert" className="border-b px-4 py-2 text-sm">
          {t('Could not refresh this mission.')}{' '}
          <Button
            variant="link"
            onClick={() =>
              running ? void synchronizeFlow() : handleRunState(false)
            }
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <AIChatBox
          key={conversationGeneration}
          incognito={false}
          conversationId={conversationId}
          onConversationCreated={rememberConversation}
          editorContext={{
            flowId: version.flowId,
            flowVersionId: version.id,
            ...(selectedStep ? { selectedStepName: selectedStep } : {}),
          }}
          onRunStateChange={handleRunState}
          beforeSend={beforeSend}
          emptyState={
            <div className="px-5 py-8">
              <h3 className="font-semibold">
                {t('Design this mission with Syd')}
              </h3>
              <p className="mt-2 text-sm text-gray-11">
                {t(
                  'Ask for a change, select a step to discuss it, or test the mission with sample data.',
                )}
              </p>
            </div>
          }
          placeholder={
            saving ? t('Saving your changes…') : t('Ask about this mission…')
          }
          footerNote={
            running
              ? t(
                  'Syd is working. You can inspect the graph; manual editing resumes when this turn finishes.',
                )
              : refreshError
              ? t('Refresh this mission to resume manual editing.')
              : t('Syd can see this mission and your selected step.')
          }
        />
      </div>
    </section>
  );
}
