import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  acceptHostedResponse,
  assertAuthSession,
} from '@/features/hosted-onboarding/auth-session';

import {
  enterOperationalWorkspace,
  useOperationalWorkspaces,
} from './workspaces-api';

export function PartnerWorkspacesPage() {
  const access = useOperationalWorkspaces();
  return <SessionWorkspaces key={access.session.epoch} access={access} />;
}

function SessionWorkspaces({
  access,
}: {
  access: ReturnType<typeof useOperationalWorkspaces>;
}) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  async function enter(platformId: string) {
    if (locked.current) return;
    locked.current = true;
    setOpening(platformId);
    setError(false);
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      const response = await enterOperationalWorkspace(
        access.session,
        platformId,
        attempt.signal,
      );
      if (attempt.signal.aborted) return;
      // Verify the origin session before replacing storage and stale tenant caches.
      acceptHostedResponse(response, access.session, () => cache.clear());
      navigate('/', { replace: true });
    } catch {
      if (attempt.signal.aborted) return;
      try {
        assertAuthSession(access.session);
      } catch {
        return;
      }
      setError(true);
    } finally {
      locked.current = false;
      if (!attempt.signal.aborted) setOpening(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <div>
        <Button variant="ghost" asChild>
          <Link to="/">{t('Back to workspace')}</Link>
        </Button>
        <h1 className="mt-6 text-2xl font-semibold">
          {t('Client workspaces')}
        </h1>
        <p className="mt-2 max-w-prose text-sm text-gray-11">
          {t(
            'Open a client workspace to build and support their workflows. Each workspace keeps its own data, connections and credits.',
          )}
        </p>
      </div>
      {!access.hosted || access.session.kind !== 'user' ? (
        <p role="status" className="text-sm text-gray-11">
          {t(
            'Sign in to your hosted Sydekyks account to view client workspaces.',
          )}
        </p>
      ) : access.isPending ? (
        <p role="status" className="text-sm text-gray-11">
          {t('Checking workspace access…')}
        </p>
      ) : access.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          <p>
            {t(
              'Workspaces could not be loaded. Check your connection and try again.',
            )}
          </p>
          <Button
            variant="outline"
            disabled={access.isFetching}
            onClick={() => void access.refetch()}
          >
            {t('Try again')}
          </Button>
        </div>
      ) : !access.allowed ? (
        <p role="status" className="text-sm text-gray-11">
          {t(
            'This area is available to approved Sydekyks partners and team members. Contact the Sydekyks team if you need access.',
          )}
        </p>
      ) : !access.data?.workspaces.length ? (
        <p role="status" className="text-sm text-gray-11">
          {t(
            'No client workspaces are assigned yet. The Sydekyks team will assign your first client here.',
          )}
        </p>
      ) : (
        <ul
          className="divide-y rounded-xl border bg-gray-1"
          aria-label={t('Available client workspaces')}
        >
          {access.data.workspaces.map((workspace) => {
            const current = workspace.platformId === access.session.platformId;
            return (
              <li
                key={workspace.platformId}
                className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6"
              >
                <div className="min-w-0 flex-1 basis-48">
                  <h2 className="break-words text-base font-medium">
                    {workspace.name}
                  </h2>
                  <p className="mt-1 text-sm text-gray-11">
                    {current
                      ? t('Current workspace')
                      : t('Separate client workspace')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={current || opening !== null}
                  onClick={() => void enter(workspace.platformId)}
                  aria-label={t('Open {{name}}', { name: workspace.name })}
                >
                  {opening === workspace.platformId
                    ? t('Opening…')
                    : current
                    ? t('Current')
                    : t('Open workspace')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {opening && (
        <p role="status" className="text-sm text-gray-11">
          {t('Opening workspace securely…')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-gray-11">
          {t(
            'The workspace could not be opened. Refresh the list to check your assignment, then try again.',
          )}
        </p>
      )}
      {access.allowed && (
        <Button
          className="self-start"
          variant="ghost"
          disabled={access.isFetching || opening !== null}
          onClick={() => {
            setError(false);
            void access.refetch();
          }}
        >
          {t('Refresh workspaces')}
        </Button>
      )}
    </main>
  );
}
