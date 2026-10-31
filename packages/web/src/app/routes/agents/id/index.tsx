import { isNil, isObject, unique } from '@activepieces/core-utils';
import { Agent, AgentToolType } from '@activepieces/shared';
import { t } from 'i18next';
import {
  ChevronLeft,
  History,
  MessageSquare,
  SearchX,
  Settings2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import { LockedFeatureGuard } from '@/app/components/locked-feature-guard';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentsAvailable } from '@/features/agents';
import { AgentMark } from '@/features/agents/agent-mark';
import { agentsQueries } from '@/features/agents/hooks/agents-hooks';
import { authenticationSession } from '@/lib/authentication-session';
import { cn } from '@/lib/utils';

import { AgentChatView } from './agent-chat-view';
import {
  AgentConfigurePanel,
  AgentConfigurePanelHandle,
} from './configure-panel';
import { AgentRuns } from './runs';

const pieceDisplayName = (pieceName: string): string =>
  pieceName.replace('@activepieces/piece-', '');

const buildCapabilityNote = (agent: Agent): string => {
  const toolNames = unique(
    agent.draft.tools.map((tool) =>
      tool.type === AgentToolType.PIECE
        ? pieceDisplayName(tool.pieceMetadata.pieceName)
        : tool.toolName,
    ),
  );
  if (toolNames.length === 0) {
    return t('{name} has no tools yet, so replies may need review', {
      name: agent.displayName,
    });
  }
  return t('{name} can use {tools} and replies may need review', {
    name: agent.displayName,
    tools: toolNames.join(', '),
  });
};

type RightPanel = 'runs' | 'configure';

const CONVERSATION_QUERY_PARAM = 'conversation';
const RUNS_TAB = 'runs';
const CHAT_TAB = 'chat';
const SLIDE_MS = 200;
const SLIDING_ASIDE =
  'shrink-0 overflow-hidden border-gray-6 transition-[width] duration-200';

const needsAModel = (agent: Agent): boolean => {
  const running = agent.published ?? agent.draft;
  return isNil(running.provider) || isNil(running.modelName);
};

const AgentEditorSkeleton = () => (
  <div className="flex h-full min-w-0 w-full flex-col overflow-hidden">
    <div className="flex h-[60px] shrink-0 items-center gap-[14px] border-b border-gray-6 px-6">
      <Skeleton className="size-12 rounded-[14px]" />
      <Skeleton className="h-5 w-[220px]" />
    </div>
    <div className="flex grow items-center justify-center p-6">
      <Skeleton className="h-[360px] w-full max-w-[720px] rounded-[19px]" />
    </div>
  </div>
);
const AgentEditorContent = () => {
  const navigate = useNavigate();
  const { agentId } = useParams<{ agentId: string }>();
  const { pathname, state: locationState } = useLocation();
  const [backTo] = useState(() => backDestination(locationState));
  const agentsAvailable = useAgentsAvailable();
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [chatWasOpened, setChatWasOpened] = useState(false);
  const [configureChosen, setConfigureChosen] = useState<boolean | undefined>(
    () =>
      isObject(locationState) && locationState.configure === true
        ? true
        : undefined,
  );
  const configureRef = useRef<AgentConfigurePanelHandle>(null);
  const [renderedPanel, setRenderedPanel] = useState<RightPanel | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationId =
    searchParams.get(CONVERSATION_QUERY_PARAM) ?? undefined;
  const [openedConversationId, setOpenedConversationId] =
    useState(conversationId);
  const [chatSessionKey, setChatSessionKey] = useState(
    () => conversationId ?? 'new',
  );

  const writeConversationParam = (nextConversationId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (nextConversationId === null) {
      next.delete(CONVERSATION_QUERY_PARAM);
    } else {
      next.set(CONVERSATION_QUERY_PARAM, nextConversationId);
    }
    setSearchParams(next, { replace: true });
  };
  const openConversation = (nextConversationId: string) => {
    setOpenedConversationId(nextConversationId);
    setChatSessionKey(nextConversationId);
    writeConversationParam(nextConversationId);
  };
  const runsOpen = pathname.endsWith(`/${RUNS_TAB}`);
  const [runsWereOpen, setRunsWereOpen] = useState(runsOpen);
  const showTab = (nextTab: string) => {
    const suffix = nextTab === RUNS_TAB ? `/${RUNS_TAB}` : '';
    const carried = new URLSearchParams();
    const openedConversation =
      openedConversationId ?? searchParams.get(CONVERSATION_QUERY_PARAM);
    if (!isNil(openedConversation)) {
      carried.set(CONVERSATION_QUERY_PARAM, openedConversation);
    }
    const query = carried.toString();
    navigate(
      authenticationSession.appendProjectRoutePrefix(
        `/agents/${agentId}${suffix}${query.length > 0 ? `?${query}` : ''}`,
      ),
      { replace: true },
    );
  };
  const startNewConversation = () => {
    setOpenedConversationId(undefined);
    setChatSessionKey(`new-${Date.now()}`);
    writeConversationParam(null);
  };
  const {
    data: agent,
    isLoading,
    isError,
  } = agentsQueries.useAgent({
    id: agentId ?? '',
    enabled: agentId !== undefined && agentsAvailable,
  });

  const needsModel = agent !== undefined && needsAModel(agent);
  const configureOpen = configureChosen ?? (needsModel && !runsOpen);
  const runsVisible = runsOpen && !configureOpen;
  const toggleRuns = () => showTab(runsVisible ? CHAT_TAB : RUNS_TAB);
  const toggleConfigure = () => {
    if (configureOpen) {
      configureRef.current?.requestExit();
      return;
    }
    setConfigureChosen(true);
    if (runsOpen) {
      showTab(CHAT_TAB);
    }
  };
  const activePanel: RightPanel | null = configureOpen
    ? 'configure'
    : runsVisible
    ? 'runs'
    : null;
  if (runsOpen !== runsWereOpen) {
    setRunsWereOpen(runsOpen);
    if (runsOpen && configureOpen) {
      setConfigureChosen(false);
    }
  }
  if (activePanel !== null && activePanel !== renderedPanel) {
    setRenderedPanel(activePanel);
  }
  useEffect(() => {
    if (agent && activePanel === null) setChatWasOpened(true);
  }, [agent, activePanel]);

  const panelIsSlidingOut = activePanel === null && renderedPanel !== null;
  useEffect(() => {
    if (!panelIsSlidingOut) {
      return;
    }
    const timer = setTimeout(() => setRenderedPanel(null), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [panelIsSlidingOut]);

  if (isLoading) {
    return <AgentEditorSkeleton />;
  }

  if (agent === undefined) {
    return (
      <Empty className="h-full">
        <EmptyHeader className="max-w-md">
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>
            {isError
              ? t('That agent could not be loaded')
              : t('That agent is gone')}
          </EmptyTitle>
          <EmptyDescription>
            {isError
              ? t('It may have been deleted, or the connection dropped.')
              : t('It may have been deleted by someone else on the project.')}
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={() => navigate('/agents')}>
          {t('Back to agents')}
        </Button>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-w-0 w-full flex-col overflow-hidden">
      <div className="flex h-[60px] shrink-0 items-center gap-2 border-b border-gray-6 px-3 sm:gap-3 sm:px-5">
        <button
          type="button"
          aria-label={t('Back')}
          onClick={() => navigate(backTo)}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
        >
          <ChevronLeft size={16} />
        </button>
        <AgentMark size="sm" icon={agent.icon} color={agent.color} />
        <div className="flex min-w-0 grow basis-0 flex-col gap-px">
          <span className="truncate text-base font-semibold leading-5 tracking-[-0.01em]">
            {agent.displayName}
          </span>
          <span className="truncate text-xs leading-4 text-gray-11">
            {agent.description ?? t('No description yet')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            className="gap-2 px-2"
            aria-label={t('Chat with agent')}
            aria-pressed={activePanel === null}
            onClick={() => {
              if (configureOpen) configureRef.current?.requestExit();
              if (runsOpen) showTab(CHAT_TAB);
            }}
          >
            <MessageSquare className="size-4" />
            <span className="hidden sm:inline">{t('Chat with agent')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="gap-2 px-2"
            aria-label={t('Run history')}
            aria-pressed={runsVisible}
            onClick={toggleRuns}
          >
            <History className="size-4" />
            <span className="hidden sm:inline">{t('Run history')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="gap-2 px-2"
            aria-label={t('Configure')}
            aria-pressed={configureOpen}
            onClick={toggleConfigure}
          >
            <Settings2 className="size-4" />
            <span className="hidden sm:inline">{t('Configure')}</span>
          </Button>
        </div>
      </div>
      <div className="relative flex min-h-0 min-w-0 grow overflow-hidden">
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1',
            activePanel !== null ? 'hidden' : 'flex',
          )}
        >
          {(activePanel === null || chatWasOpened) && (
            <AgentChatView
              key={agent.id}
              agent={agent}
              conversationsOpen={conversationsOpen}
              openedConversationId={openedConversationId ?? conversationId}
              chatSessionKey={chatSessionKey}
              footerNote={buildCapabilityNote(agent)}
              onSelectConversation={openConversation}
              onNewConversation={startNewConversation}
              onCollapseConversations={() => {
                setConversationsOpen(false);
              }}
              onExpandConversations={() => {
                setConversationsOpen(true);
              }}
              onConversationCreated={writeConversationParam}
            />
          )}
        </div>
        <aside
          className={cn(
            SLIDING_ASIDE,
            'bg-panel',
            activePanel !== null ? 'w-full' : 'w-0',
          )}
        >
          {renderedPanel !== null && (
            <div
              key={renderedPanel}
              className="flex h-full w-full flex-col animate-in fade-in duration-150 mx-auto max-w-3xl"
            >
              {renderedPanel === 'runs' ? (
                <AgentRuns
                  agentId={agent.id}
                  onClose={() => showTab(CHAT_TAB)}
                />
              ) : (
                <AgentConfigurePanel
                  key={agent.id}
                  ref={configureRef}
                  agent={agent}
                  onExit={() => setConfigureChosen(false)}
                />
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

function backDestination(state: unknown): string {
  if (
    typeof state === 'object' &&
    state !== null &&
    'backTo' in state &&
    typeof state.backTo === 'string'
  ) {
    return state.backTo;
  }
  return '/agents';
}

const AgentEditorPage = () => {
  const agentsAvailable = useAgentsAvailable();
  return (
    <LockedFeatureGuard
      featureKey="AGENTS"
      locked={!agentsAvailable}
      lockTitle={t('Unlock Agents')}
      lockDescription={t('Build an agent once, then use it in any flow.')}
    >
      <AgentEditorContent />
    </LockedFeatureGuard>
  );
};

export { AgentEditorPage };
