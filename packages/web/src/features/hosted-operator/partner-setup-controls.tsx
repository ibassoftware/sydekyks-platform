import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const Status = z.object({
  platformId: z.string(),
  userId: z.string(),
  identityId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  pending: z.boolean(),
  expiresAt: z.string().nullable(),
});
async function request(
  session: Session,
  path: string,
  data?: unknown,
  signal?: AbortSignal,
) {
  assertAuthSession(session);
  try {
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/operator/partner-setup' + path,
      { method: data ? 'POST' : 'GET', ...(data ? { data } : {}), signal },
    );
    assertAuthSession(session);
    const parsed = Status.extend({
      setupUrl: z.string().nullable().optional(),
    }).safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.platformId !== session.platformId ||
      parsed.data.userId !== session.id
    )
      throw new Error('Setup unavailable');
    return parsed.data;
  } catch {
    assertAuthSession(session);
    throw new Error(
      'Setup link was not confirmed. Refresh the account and review its current status before trying again.',
    );
  }
}
export function PartnerSetupControls({
  session,
  email,
  onChanged,
}: {
  session: Session;
  email: string;
  onChanged: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [url, setUrl] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const status = useQuery({
    queryKey: ['partner-setup-status', session.epoch, email],
    queryFn: ({ signal }) =>
      request(
        session,
        '?email=' + encodeURIComponent(email),
        undefined,
        signal,
      ),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  async function change(action: 'issue' | 'revoke') {
    if (!status.data || locked.current || (action === 'issue' && !confirmed))
      return;
    locked.current = true;
    setBusy(true);
    setNotice(null);
    setUrl(null);
    try {
      const result = await request(session, '/' + action, {
        email,
        expectedRevision: status.data.revision,
        requestKey: crypto.randomUUID(),
      });
      if (mounted.current) {
        if (result.setupUrl) {
          const link = new URL(result.setupUrl);
          if (
            link.origin !== window.location.origin ||
            link.pathname !== '/partner-setup' ||
            !/^#token=[a-zA-Z0-9_-]{43}$/.test(link.hash)
          )
            throw new Error('Unexpected setup link');
          setUrl(result.setupUrl);
        }
        setConfirmed(false);
        setNotice(
          action === 'revoke'
            ? t('Pending setup links revoked.')
            : t(
                'One-time setup link created. Copy it now and share it privately. It is not sent by email and cannot be retrieved later.',
              ),
        );
        void status.refetch();
        onChanged();
      }
    } catch {
      if (mounted.current)
        setNotice(
          t(
            'The change was not confirmed. Refresh setup status before trying again; creating a replacement invalidates the earlier link.',
          ),
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function copy() {
    if (!url) return;
    try {
      assertAuthSession(session);
      await navigator.clipboard.writeText(url);
      assertAuthSession(session);
      if (mounted.current)
        setNotice(
          t('Setup link copied. Share it privately with the intended person.'),
        );
    } catch {
      if (mounted.current)
        setNotice(
          t(
            'Clipboard access is unavailable. Select the private link field and copy it, or create a replacement later.',
          ),
        );
    }
  }
  return (
    <section
      aria-labelledby="manual-setup-heading"
      className="mt-5 max-w-3xl rounded-lg border border-gray-6 p-4"
    >
      <h3 id="manual-setup-heading" className="text-base font-semibold">
        {t('Set up without email delivery')}
      </h3>
      <p className="mt-2 text-sm leading-6 text-gray-11">
        {t(
          'Create a private link for this account. The recipient chooses their own password. This records manual operator admission, not verified ownership of an email inbox. Partner approval and client assignments remain separate.',
        )}
      </p>
      <p className="mt-3 break-all text-sm font-medium">{email}</p>
      {status.isPending ? (
        <p role="status" className="mt-3 text-sm">
          {t('Checking setup status…')}
        </p>
      ) : status.isError ? (
        <p role="alert" className="mt-3 text-sm">
          {t('Setup status could not load. Refresh before creating a link.')}
        </p>
      ) : (
        <>
          {status.data?.pending && (
            <p className="mt-3 text-sm">
              {t(
                'A pending link already exists. A replacement revokes it. Links expire after 24 hours and work once.',
              )}
            </p>
          )}
          <label className="mt-4 flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-accent-9"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {t(
                'I confirm the intended person should receive this account setup link and I will share it privately.',
              )}
            </span>
          </label>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={!confirmed || busy || status.isFetching}
              onClick={() => void change('issue')}
            >
              {status.data?.pending
                ? t('Replace setup link')
                : t('Create setup link')}
            </Button>
            {status.data?.pending && (
              <Button
                variant="outline"
                disabled={busy || status.isFetching}
                onClick={() => void change('revoke')}
              >
                {t('Revoke pending links')}
              </Button>
            )}
          </div>
        </>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="mt-3"
        disabled={busy || status.isFetching}
        onClick={() => void status.refetch()}
      >
        {t('Refresh setup status')}
      </Button>
      {url && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm leading-6">
            {t(
              'This is the private one-time setup link, including its access token. Use Copy setup link or open the setup page below; the generic signup page is not this link.',
            )}
          </p>
          <Input
            type="password"
            aria-label={t('Private setup link')}
            autoComplete="off"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
          <Button variant="outline" onClick={() => void copy()}>
            {t('Copy setup link')}
          </Button>
          <Button variant="ghost" onClick={() => setUrl(null)}>
            {t('Hide link')}
          </Button>
          <a
            className="w-fit text-primary underline underline-offset-4"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {t('Open private setup page')}
          </a>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm leading-6">
          {notice}
        </p>
      )}
    </section>
  );
}
