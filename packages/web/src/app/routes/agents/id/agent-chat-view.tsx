import { Agent } from '@activepieces/shared';
import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';

import { AIChatBox } from '@/app/routes/chat-with-ai/ai-chat-box';
import { ConversationsToggle } from '@/app/routes/chat-with-ai/components/conversations-toggle';
import { ConversationList } from '@/app/routes/chat-with-ai/conversation-list';
import { AgentChatWelcome } from '@/features/agents/agent-chat-welcome';
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
}: AgentChatViewProps) => {
  const queryClient = useQueryClient();
  return (
    <>
      <aside
        className={cn(
          'shrink-0 overflow-hidden border-r border-gray-6',
          conversationsOpen
            ? 'absolute inset-y-0 left-0 z-20 w-full bg-panel md:relative md:inset-auto md:z-auto md:w-[220px]'
            : 'hidden md:block md:w-[46px]',
        )}
      >
        {conversationsOpen ? (
          <ConversationList
            agentId={agent.id}
            className="w-full"
            selectedId={openedConversationId ?? null}
            onSelect={(id) => {
              onSelectConversation(id);
              if (window.innerWidth < 768) onCollapseConversations();
            }}
            onNewChat={() => {
              onNewConversation();
              if (window.innerWidth < 768) onCollapseConversations();
            }}
            onCollapse={onCollapseConversations}
          />
        ) : (
          <div className="flex h-full w-[46px] flex-col items-center pt-3">
            <ConversationsToggle open={false} onClick={onExpandConversations} />
          </div>
        )}
      </aside>
      <div
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col',
          conversationsOpen ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="shrink-0 border-b px-3 py-2 md:hidden">
          <ConversationsToggle open={false} onClick={onExpandConversations} />
        </div>
        <AIChatBox
          key={chatSessionKey}
          incognito={false}
          agentId={agent.id}
          conversationId={openedConversationId ?? null}
          onConversationCreated={onConversationCreated}
          onTurnEnd={() =>
            void queryClient.invalidateQueries({
              queryKey: ['agents', 'one', agent.id],
            })
          }
          placeholder={t('Ask {name}...', { name: agent.displayName })}
          footerNote={footerNote}
          emptyState={
            <AgentChatWelcome
              displayName={agent.displayName}
              description={agent.description ?? null}
              icon={agent.icon}
              color={agent.color}
            />
          }
        />
      </div>
    </>
  );
};

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
};
