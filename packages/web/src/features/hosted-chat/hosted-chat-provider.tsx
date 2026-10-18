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
  children,
}: {
  conversationId?: string | null;
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
    >
      {children}
    </HostedChatProvider>
  );
}
function HostedChatProvider({
  session,
  projectPointer,
  conversationId,
  children,
}: {
  session: ReturnType<typeof useHostedAuthSession>;
  projectPointer: string;
  conversationId: string | null;
  children: React.ReactNode;
}) {
  const scope = useMemo(
    () => ({ session, projectPointer, conversationId }),
    [session, projectPointer, conversationId],
  );
  const [payer, setPayer] = useState<HostedChatPayer | null>(null);
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
  let selectionError: HostedChatError | null = null;
  try {
    assertHostedPayerAvailable(payer, query.data);
  } catch (error) {
    selectionError = error as HostedChatError;
  }
  if (
    !selectionError &&
    query.data &&
    BigInt(query.data.credits.execution.available) === 0n
  )
    selectionError = new HostedChatError('credits');
  const ready = !denied && !query.isFetching && !query.error && !selectionError;
  const context = {
    scope,
    payer,
    setPayer,
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
      const captured = payer ? { ...payer } : null;
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
      return {
        payer: captured,
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
