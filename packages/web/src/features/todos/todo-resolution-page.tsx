import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { CircleCheck } from 'lucide-react';
import { FormEvent, useState } from 'react';
import {
  Link,
  Navigate,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import { FullLogo } from '@/components/custom/full-logo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

import { todoApi, TodoView } from './todo-api';

export function TodoResolutionPage() {
  const session = useHostedAuthSession();
  const location = useLocation();
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  if (session.kind !== 'user') {
    const from = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/sign-in?from=${from}`} replace />;
  }
  return (
    <TodoResolutionSession
      key={`${session.epoch}:${id}`}
      id={id}
      session={session}
      suggestedStatus={search.get('status')}
    />
  );
}

function TodoResolutionSession({
  id,
  session,
  suggestedStatus,
}: {
  id: string;
  session: ReturnType<typeof useHostedAuthSession>;
  suggestedStatus: string | null;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const key = ['todo-resolution', session.epoch, id];
  const task = useQuery({
    queryKey: key,
    queryFn: async () => {
      assertAuthSession(session);
      const view = await todoApi.get(id);
      assertAuthSession(session);
      return view;
    },
    retry: false,
    refetchOnWindowFocus: true,
  });
  const [mustReload, setMustReload] = useState(false);
  const resolution = useMutation({
    mutationFn: async (body: { status: string; message?: string }) => {
      assertAuthSession(session);
      const view = await todoApi.resolve(id, body);
      assertAuthSession(session);
      return view;
    },
    retry: false,
    onSuccess: (view) => client.setQueryData(key, view),
    onError: () => setMustReload(true),
  });
  const reload = async () => {
    const result = await task.refetch();
    if (result.isSuccess) {
      setMustReload(false);
      resolution.reset();
    }
  };
  return (
    <main className="min-h-screen bg-gray-1 text-gray-12">
      <div className="mx-auto max-w-2xl px-5 py-6 sm:px-8 sm:py-10">
        <header className="mb-10 flex items-center justify-between gap-4 border-b border-gray-6 pb-5">
          <Link to="/" aria-label={t('Sydekyks home')}>
            <FullLogo className="h-9" />
          </Link>
          <Link
            to="/"
            className="text-sm text-accent-11 underline underline-offset-4"
          >
            {t('Open workspace')}
          </Link>
        </header>
        {task.isPending ? (
          <section
            role="status"
            aria-label={t('Loading task')}
            className="space-y-5"
          >
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-28 w-full" />
            <span className="sr-only">{t('Loading task…')}</span>
          </section>
        ) : task.isError ? (
          <section className="space-y-4" role="alert">
            <h1 className="text-2xl font-semibold">{t('Task unavailable')}</h1>
            <p className="text-sm text-gray-11">{taskError(task.error)}</p>
            {api.isError(task.error) && task.error.response?.status === 401 ? (
              <Button asChild>
                <Link
                  to={`/sign-in?from=${encodeURIComponent(
                    location.pathname + location.search,
                  )}`}
                >
                  {t('Sign in again')}
                </Link>
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => void reload()}
                loading={task.isFetching}
              >
                {t('Reload task')}
              </Button>
            )}
          </section>
        ) : (
          <TodoResolutionView
            key={task.data.id}
            task={task.data}
            suggestedStatus={suggestedStatus}
            submitting={resolution.isPending}
            mustReload={mustReload}
            reloading={task.isFetching}
            onReload={() => void reload()}
            onSubmit={(body) => resolution.mutate(body)}
          />
        )}
      </div>
    </main>
  );
}

function taskError(error: unknown) {
  const status = api.isError(error) ? error.response?.status : undefined;
  if (status === 401)
    return t(
      'Your session has expired. Sign in again, then reopen this task link.',
    );
  if (status === 403 || status === 404)
    return t(
      'This task is unavailable to your account. Check that you are signed in to the right workspace, or ask its administrator for access.',
    );
  return t('We could not load this task. Check your connection and reload it.');
}

export function TodoResolutionView({
  task,
  suggestedStatus,
  submitting,
  mustReload,
  reloading,
  onReload,
  onSubmit,
}: {
  task: TodoView;
  suggestedStatus: string | null;
  submitting: boolean;
  mustReload: boolean;
  reloading: boolean;
  onReload: () => void;
  onSubmit: (body: { status: string; message?: string }) => void;
}) {
  const [status, setStatus] = useState(
    task.statusOptions.some((option) => option.name === suggestedStatus)
      ? suggestedStatus ?? ''
      : '',
  );
  const [message, setMessage] = useState('');
  const validStatus = task.statusOptions.some(
    (option) => option.name === status,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      !validStatus ||
      mustReload ||
      submitting ||
      !task.canResolve ||
      task.resolved
    )
      return;
    onSubmit({
      status,
      ...(message.trim() ? { message: message.trim() } : {}),
    });
  };
  return (
    <article>
      <h1 className="break-words text-2xl font-semibold tracking-tight">
        {task.title}
      </h1>
      {task.description && (
        <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-gray-11">
          {task.description}
        </p>
      )}
      {task.resolved ? (
        <section
          className="mt-8 space-y-3 border-y border-gray-6 py-6"
          aria-live="polite"
        >
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <CircleCheck
              className="size-5 shrink-0 text-accent-11"
              aria-hidden="true"
            />
            {t('Decision recorded')}
          </h2>
          <p className="break-words font-medium">{task.status?.name}</p>
          {task.message && (
            <p className="whitespace-pre-wrap break-words text-sm text-gray-11">
              {task.message}
            </p>
          )}
          <p className="text-sm text-gray-11">
            {t('This task is complete. You can close this page.')}
          </p>
        </section>
      ) : !task.canResolve ? (
        <section className="mt-8 space-y-3 border-y border-gray-6 py-6">
          <h2 className="text-lg font-medium">{t('Waiting for a decision')}</h2>
          <p className="text-sm text-gray-11">
            {t(
              'Only the assigned person or a workspace administrator can resolve this task. Ask them to open this link.',
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={onReload}
            loading={reloading}
          >
            {t('Reload task')}
          </Button>
        </section>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-7">
          <fieldset
            disabled={submitting || mustReload}
            className="min-w-0 space-y-2"
          >
            <legend className="mb-3 text-sm font-medium">
              {t('Choose your decision')}
            </legend>
            {task.statusOptions.map((option, index) => (
              <label
                key={option.name}
                htmlFor={`todo-status-${index}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-6 p-4 has-[:checked]:border-accent-9 has-[:checked]:bg-accent-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-60"
              >
                <input
                  id={`todo-status-${index}`}
                  type="radio"
                  name="todo-status"
                  value={option.name}
                  checked={status === option.name}
                  onChange={() => setStatus(option.name)}
                  className="mt-0.5 size-4 shrink-0 accent-accent-9 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-9"
                />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium">
                    {option.name}
                  </span>
                  {option.description && (
                    <span className="mt-1 block break-words text-sm text-gray-11">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="space-y-2">
            <label htmlFor="todo-message" className="text-sm font-medium">
              {t('Message (optional)')}
            </label>
            <Textarea
              id="todo-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              minRows={3}
              maxRows={10}
              maxLength={4000}
              disabled={submitting || mustReload}
              aria-describedby="todo-message-help"
            />
            <p id="todo-message-help" className="text-sm text-gray-11">
              {t(
                'Add any context the workflow owner needs. Up to 4,000 characters.',
              )}
            </p>
          </div>
          {mustReload && (
            <div role="alert" className="space-y-3 border-y border-gray-6 py-4">
              <p className="text-sm">
                {t(
                  'We could not confirm your decision. Reload the task to check its latest status before submitting again.',
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={onReload}
                loading={reloading}
              >
                {t('Reload task')}
              </Button>
            </div>
          )}
          <div className="space-y-3 border-t border-gray-6 pt-6">
            <Button
              type="submit"
              size="lg"
              className="w-full sm:w-auto"
              disabled={!validStatus || mustReload || submitting}
              loading={submitting}
            >
              {t('Submit decision')}
            </Button>
            <p className="text-sm text-gray-11">
              {t(
                'Submitting records your decision and may continue the workflow.',
              )}
            </p>
          </div>
        </form>
      )}
    </article>
  );
}
