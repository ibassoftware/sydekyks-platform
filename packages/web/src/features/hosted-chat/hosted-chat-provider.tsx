import { useQuery } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { useHostedAuthSession } from '@/features/hosted-onboarding/auth-session';
import { authenticationSession } from '@/lib/authentication-session';

import {
  assertHostedChatScope,
  assertHostedPayerAvailable,
  hostedChatApi,
  HostedChatError,
  HostedChatPayer,
  HostedChatSubmission,
} from './hosted-chat-api';

function projectPointer() {
  try {
    return authenticationSession.getProjectId();
  } catch {
    return null;
  }
}
function subscribeProject(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener('focus', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('focus', listener);
  };
}
export function HostedChatBoundary({
  conversationId,
  agentId,
  builder,
  children,
}: {
  conversationId?: string | null;
  agentId?: string;
  builder?: boolean;
  children: React.ReactNode;
}) {
  const session = useHostedAuthSession();
  const pointer = useSyncExternalStore(
    subscribeProject,
    projectPointer,
    () => null,
  );
  if (session.kind !== 'user' || !pointer)
    return (
      <p className="p-4 text-sm text-gray-11" role="status">
        Sign in and choose a project to use hosted chat.
      </p>
    );
  // Changing login/project unmounts private chat history, pending sends and selection together.
  return (
    <HostedChatProvider
      key={`${session.epoch}:${pointer}`}
      session={session}
      projectPointer={pointer}
      conversationId={conversationId ?? null}
      agentId={agentId}
      builder={builder}
    >
      {children}
    </HostedChatProvider>
  );
}
function HostedChatProvider({
  session,
  projectPointer,
  conversationId,
  agentId,
  builder,
  children,
}: {
  session: ReturnType<typeof useHostedAuthSession>;
  projectPointer: string;
  conversationId: string | null;
  agentId?: string;
  builder?: boolean;
  children: React.ReactNode;
}) {
  const scope = useMemo(
    () => ({
      session,
      projectPointer,
      conversationId,
      agentId,
      builder,
      nativeAgent: agentId !== undefined || builder === true,
    }),
    [session, projectPointer, conversationId, agentId, builder],
  );
  const [payer, setPayer] = useState<HostedChatPayer | null>(null);
  const [nativeWebSearch, setNativeWebSearch] = useState(false);
  const initialPayerResolved = useRef(false);
  const [deniedFor, setDeniedFor] = useState<string | null | undefined>(
    undefined,
  );
  const denied = deniedFor === conversationId;
  const ownConversation = useRef<string | null>(null);
  const generation = useRef({ conversationId, value: 0 });
  if (generation.current.conversationId !== conversationId)
    generation.current = {
      conversationId,
      value: generation.current.value + 1,
    };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const previousConversation = useRef(conversationId);
  useEffect(() => {
    if (previousConversation.current !== conversationId) {
      const createdTransition =
        previousConversation.current === null &&
        conversationId === ownConversation.current;
      if (!createdTransition) setPayer(null);
      if (!createdTransition) setNativeWebSearch(false);
      ownConversation.current = null;
    }
    previousConversation.current = conversationId;
  }, [conversationId]);
  const query = useQuery({
    queryKey: [
      'hosted-chat-options',
      session.epoch,
      session.platformId,
      session.id,
      projectPointer,
      conversationId,
      agentId,
      builder,
    ],
    queryFn: ({ signal }) => hostedChatApi.options(scope, signal),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    enabled: !denied,
    refetchOnWindowFocus: !denied,
  });
  useEffect(() => {
    if (
      query.error instanceof HostedChatError &&
      ['session', 'denied'].includes(query.error.kind)
    )
      setDeniedFor(conversationId);
  }, [query.error, conversationId]);
  useEffect(() => {
    if (scope.nativeAgent || initialPayerResolved.current) return;
    if (query.error) {
      initialPayerResolved.current = true;
      return;
    }
    if (query.isFetching || !query.data) return;
    initialPayerResolved.current = true;
    if (!payer && !query.data.payerLock && query.data.managedAvailable)
      setPayer({ type: 'managed' });
  }, [scope.nativeAgent, query.error, query.isFetching, query.data, payer]);
  const effectivePayer = query.data?.payerLock ?? payer;
  let selectionError: HostedChatError | null = null;
  try {
    if (scope.nativeAgent && !query.data?.payerLock)
      throw new HostedChatError('unavailable');
    assertHostedPayerAvailable(effectivePayer, query.data);
  } catch (error) {
    selectionError = error as HostedChatError;
  }
  if (query.data && BigInt(query.data.credits.execution.available) === 0n)
    selectionError = new HostedChatError('credits');
  const ready = !denied && !query.isFetching && !query.error && !selectionError;
  const context = {
    scope,
    payer: effectivePayer,
    payerLocked: query.data?.payerLock !== undefined,
    nativeWebSearch,
    setNativeWebSearch,
    setPayer: (next: HostedChatPayer) => {
      initialPayerResolved.current = true;
      setPayer(next);
    },
    options: query.error || denied ? undefined : query.data,
    ready,
    loading: query.isFetching,
    denied,
    error:
      query.error ??
      (denied ? new HostedChatError('denied') : null) ??
      (query.data ? selectionError : null),
    refresh: () => {
      if (!denied) void query.refetch();
    },
    async prepare(): Promise<HostedChatSubmission> {
      const captured = effectivePayer ? { ...effectivePayer } : null;
      const capturedWebSearch = nativeWebSearch;
      const capturedGeneration = generation.current.value;
      let createdId: string | null = null;
      const assertCurrent = () => {
        if (
          !alive.current ||
          (generation.current.value !== capturedGeneration &&
            !(
              scope.conversationId === null &&
              createdId &&
              generation.current.conversationId === createdId &&
              generation.current.value === capturedGeneration + 1
            ))
        )
          throw new HostedChatError('session');
        assertHostedChatScope(scope);
      };
      assertCurrent();
      if (denied || !ready)
        throw context.error ?? new HostedChatError('unavailable');
      // Capture first, then revalidate metadata before creating or submitting a run.
      const result = await query.refetch({ throwOnError: true });
      assertCurrent();
      assertHostedPayerAvailable(captured, result.data);
      if (capturedWebSearch && !result.data?.nativeFeatures?.webSearch)
        throw new HostedChatError('unavailable');
      if (
        (scope.nativeAgent && !result.data?.payerLock) ||
        JSON.stringify(result.data?.payerLock ?? captured) !==
          JSON.stringify(captured)
      )
        throw new HostedChatError('selection');
      return {
        payer: captured,
        nativeWebSearch: capturedWebSearch,
        projectId: result.data!.projectId,
        scope,
        assertCurrent,
        bindConversation(id) {
          assertCurrent();
          createdId = id;
          ownConversation.current = id;
        },
      };
    },
  };
  return (
    <HostedChatContext.Provider value={context}>
      {children}
    </HostedChatContext.Provider>
  );
}
type HostedChatContextValue = {
  scope: import('./hosted-chat-api').HostedChatScope;
  payer: HostedChatPayer | null;
  payerLocked: boolean;
  nativeWebSearch: boolean;
  setNativeWebSearch: (enabled: boolean) => void;
  setPayer: (payer: HostedChatPayer) => void;
  options?: import('./hosted-chat-api').HostedChatOptions;
  ready: boolean;
  loading: boolean;
  denied: boolean;
  error: Error | null;
  refresh: () => void;
  prepare: () => Promise<HostedChatSubmission>;
};
const HostedChatContext = createContext<HostedChatContextValue | null>(null);
export function useHostedChatPayer() {
  return useContext(HostedChatContext);
}
