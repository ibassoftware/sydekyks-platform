import { Permission } from '@activepieces/core-utils';
import { Agent } from '@activepieces/shared';
import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useCallback, useRef, useState } from 'react';

import { AIChatBox } from '@/app/routes/chat-with-ai/ai-chat-box';
import { ConversationsToggle } from '@/app/routes/chat-with-ai/components/conversations-toggle';
import { ConversationList } from '@/app/routes/chat-with-ai/conversation-list';
import { Button } from '@/components/ui/button';
import { AgentChatWelcome } from '@/features/agents/agent-chat-welcome';
import { useAuthorization } from '@/hooks/authorization-hooks';
import { authenticationSession } from '@/lib/authentication-session';
import { cn } from '@/lib/utils';

export const AgentChatView = ({
  agent,
  conversationsOpen,
  openedConversationId,
  chatSessionKey,
  footerNote,
  onSelectConversation,
  onNewConversation,
  onCollapseConversations,
  onExpandConversations,
  onConversationCreated,
  onOpenConfigure,
  onDesignRunStateChange,
  beforeDesignSend,
}: AgentChatViewProps) => {
  const queryClient = useQueryClient();
  const { checkAccess } = useAuthorization(agent.projectId);
  const mayDesign = checkAccess(Permission.WRITE_AGENT);
  const storageKey = `syd-agent-builder:${authenticationSession.getCurrentUserId()}:${
    agent.id
  }`;
  const [designMode, setDesignMode] = useState(
    () => sessionStorage.getItem(`${storageKey}:mode`) === 'design',
  );
  const [designConversationId, setDesignConversationId] = useState<
    string | null
  >(() => sessionStorage.getItem(storageKey));
  const designing = designMode && mayDesign;
  const [designRunning, setDesignRunning] = useState(false);
  const [designRefreshFailed, setDesignRefreshFailed] = useState(false);
  const [designBlocked, setDesignBlocked] = useState(false);
  const generation = useRef(0);
  const handleDesignRunState = useCallback(
    (active: boolean) => {
      const current = ++generation.current;
      if (active) {
        setDesignRunning(true);
        onDesignRunStateChange(true);
        return;
      }
      void queryClient
        .invalidateQueries(
          { queryKey: ['agents', 'one', agent.id] },
          { throwOnError: true },
        )
        .then(() => {
          if (current !== generation.current) return;
          setDesignRefreshFailed(false);
          setDesignRunning(false);
          onDesignRunStateChange(false);
        })
        .catch(() => {
          if (current === generation.current) setDesignRefreshFailed(true);
        });
    },
    [agent.id, onDesignRunStateChange, queryClient],
  );
  const changeMode = (design: boolean) => {
    setDesignMode(design);
    sessionStorage.setItem(`${storageKey}:mode`, design ? 'design' : 'chat');
    if (design && window.matchMedia('(min-width: 1280px)').matches)
      onOpenConfigure();
  };
  const beforeSend = () => {
    if (designRefreshFailed) return false;
    const allowed = beforeDesignSend();
    setDesignBlocked(!allowed);
    if (allowed) handleDesignRunState(true);
    return allowed;
  };

  return (
    <>
      {!designing && (
        <aside
          className={cn(
            SLIDING_ASIDE,
            'border-r',
            conversationsOpen ? 'w-[220px]' : 'w-[46px]',
          )}
        >
          {conversationsOpen ? (
            <div className="flex h-full w-[220px] flex-col">
              <ConversationList
                agentId={agent.id}
                selectedId={openedConversationId ?? null}
                onSelect={onSelectConversation}
                onNewChat={onNewConversation}
                onCollapse={onCollapseConversations}
              />
            </div>
          ) : (
            <div className="flex h-full w-[46px] shrink-0 flex-col items-center pt-3">
              <ConversationsToggle
                open={false}
                onClick={onExpandConversations}
              />
            </div>
          )}
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 grow flex-col">
        <div className="flex flex-wrap gap-1 border-b px-4 py-2">
          <Button
            size="sm"
            variant={designing ? 'ghost' : 'secondary'}
            aria-pressed={!designing}
            disabled={designRunning}
            onClick={() => changeMode(false)}
          >
            {t('Chat with agent')}
          </Button>
          {mayDesign && (
            <Button
              size="sm"
              variant={designing ? 'secondary' : 'ghost'}
              aria-pressed={designing}
              disabled={designRunning}
              onClick={() => changeMode(true)}
            >
              {t('Design with Syd')}
            </Button>
          )}
        </div>
        {designing && designRefreshFailed && (
          <div role="alert" className="px-4 py-2 text-sm">
            {t('Could not refresh this agent. Retry to resume editing.')}{' '}
            <Button variant="link" onClick={() => handleDesignRunState(false)}>
              {t('Retry')}
            </Button>
          </div>
        )}
        {designing && designBlocked && (
          <p role="alert" className="px-4 py-2 text-sm">
            {t(
              'Save or discard your configuration changes before asking Syd to edit this agent.',
            )}
          </p>
        )}
        <AIChatBox
          key={designing ? `${agent.id}:design` : chatSessionKey}
          incognito={false}
          agentId={agent.id}
          builder={designing}
          conversationId={
            designing ? designConversationId : openedConversationId ?? null
          }
          onConversationCreated={
            designing
              ? (id) => {
                  sessionStorage.setItem(storageKey, id);
                  setDesignConversationId(id);
                }
              : onConversationCreated
          }
          onRunStateChange={designing ? handleDesignRunState : undefined}
          beforeSend={designing ? beforeSend : undefined}
          onTurnEnd={() =>
            void queryClient.invalidateQueries({
              queryKey: ['agents', 'one', agent.id],
            })
          }
          placeholder={
            designing
              ? t('Ask Syd to change this agent…')
              : t('Ask {name}...', { name: agent.displayName })
          }
          footerNote={
            designing
              ? t('Syd can update this agent’s draft. Publish when ready.')
              : footerNote
          }
          emptyState={
            designing ? (
              <div className="px-5 py-8">
                <h2 className="font-semibold">{t('Design with Syd')}</h2>
                <p className="mt-2 text-sm text-gray-11">
                  {t(
                    'Describe a change to this agent’s instructions or tools.',
                  )}
                </p>
              </div>
            ) : (
              <AgentChatWelcome
                displayName={agent.displayName}
                description={agent.description ?? null}
                icon={agent.icon}
                color={agent.color}
              />
            )
          }
        />
      </div>
    </>
  );
};

const SLIDING_ASIDE =
  'shrink-0 overflow-hidden border-gray-6 transition-[width] duration-200';

type AgentChatViewProps = {
  agent: Agent;
  conversationsOpen: boolean;
  openedConversationId: string | undefined;
  chatSessionKey: string;
  footerNote: string;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  onCollapseConversations: () => void;
  onExpandConversations: () => void;
  onConversationCreated: (conversationId: string) => void;
  onOpenConfigure: () => void;
  onDesignRunStateChange: (running: boolean) => void;
  beforeDesignSend: () => boolean;
};
