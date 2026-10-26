import { AuthenticationResponse, PasswordType } from '@activepieces/shared';
import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  acceptHostedResponse,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { API_URL } from '@/lib/api';
import {
  forgetPartnerSetupSecret,
  getPartnerSetupSecret,
} from '@/lib/partner-setup-secret';

const Preview = z.object({
  email: z.string(),
  workspaceName: z.string(),
  role: z.string(),
  mode: z.enum(['setup', 'existing']),
  expiresAt: z.string(),
});
async function request(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(API_URL + '/v1/hosting/tenant-join/' + path, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error('Workspace invitation unavailable');
  return response.json();
}
export function TenantJoinPage() {
  const [token] = useState(getPartnerSetupSecret),
    [preview, setPreview] = useState<z.infer<typeof Preview> | null>(null);
  const [state, setState] = useState<
    'loading' | 'ready' | 'saving' | 'complete' | 'unavailable'
  >(token ? 'loading' : 'unavailable');
  const [error, setError] = useState<string | null>(null);
  const session = useHostedAuthSession(),
    client = useQueryClient(),
    mounted = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    if (token)
      request('inspect', { token }, abort.signal)
        .then((raw) => {
          const result = Preview.parse(raw);
          if (mounted.current && !abort.signal.aborted) {
            setPreview(result);
            setState('ready');
          }
        })
        .catch(() => {
          if (mounted.current && !abort.signal.aborted) {
            forgetPartnerSetupSecret();
            setState('unavailable');
          }
        });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !preview || state !== 'ready' || locked.current) return;
    const form = event.currentTarget,
      data = new FormData(form),
      password = String(data.get('password') ?? '');
    if (
      !PasswordType.safeParse(password).success ||
      (preview.mode === 'setup' && password !== data.get('confirmPassword'))
    ) {
      setError(t('Check your password and confirmation. Use 8–64 characters.'));
      return;
    }
    const capturedSession = session;
    locked.current = true;
    setState('saving');
    setError(null);
    const fullName = String(data.get('fullName') ?? '').trim();
    form.reset();
    try {
      const result = AuthenticationResponse.parse(
        await request('redeem', {
          token,
          password,
          ...(preview.mode === 'setup' ? { fullName } : {}),
        }),
      );
      if (mounted.current) {
        acceptHostedResponse(result, capturedSession, () => client.clear());
        setState('complete');
      }
      forgetPartnerSetupSecret();
    } catch {
      forgetPartnerSetupSecret();
      if (mounted.current) setState('unavailable');
    } finally {
      locked.current = false;
    }
  }
  return (
    <main className="min-h-dvh bg-gray-2 px-4 py-8 sm:py-16">
      <section
        className="mx-auto max-w-lg rounded-xl border border-gray-6 bg-gray-1 p-5 sm:p-8"
        aria-labelledby="tenant-join-heading"
      >
        <h1 id="tenant-join-heading" className="text-xl font-semibold">
          {state === 'complete'
            ? t('You joined the workspace')
            : t('Join your workspace')}
        </h1>
        {state === 'loading' && (
          <p role="status" className="mt-5 text-sm">
            {t('Checking your invitation…')}
          </p>
        )}
        {state === 'unavailable' && (
          <div role="status" className="mt-5 space-y-4 text-sm leading-6">
            <p>
              {t(
                'The invitation could not be confirmed. If you already joined, sign in. Otherwise reopen the original private link or ask your workspace admin for a replacement. The link is removed from the address bar and is not kept after a reload.',
              )}
            </p>
            <Link
              className="text-accent-11 underline underline-offset-4"
              to="/sign-in"
            >
              {t('Go to sign in')}
            </Link>
          </div>
        )}
        {state === 'complete' && (
          <div role="status" className="mt-5 space-y-4 text-sm leading-6">
            <p>
              {t(
                'Your workspace membership is ready. This invitation does not grant Partner status or a new trial.',
              )}
            </p>
            <Link className="text-accent-11 underline underline-offset-4" to="/">
              {t('Open workspace')}
            </Link>
          </div>
        )}
        {preview && (state === 'ready' || state === 'saving') && (
          <>
            <p className="mt-4 break-words text-sm leading-6">
              {t('Join {workspace} as {role}.', {
                workspace: preview.workspaceName,
                role: preview.role,
              })}
            </p>
            <p className="mt-2 break-all text-sm font-medium">
              {preview.email}
            </p>
            <p className="mt-3 text-sm leading-6 text-gray-11">
              {preview.mode === 'setup'
                ? t(
                    'Your workspace admin issued this private link. Choose your own password. This records admin admission, not proof of email inbox ownership.',
                  )
                : t(
                    'Use this account’s current password to accept. Your existing password and other memberships stay unchanged.',
                  )}
            </p>
            <form
              className="mt-6 space-y-4"
              onSubmit={submit}
              aria-busy={state === 'saving'}
            >
              {preview.mode === 'setup' && (
                <div>
                  <label htmlFor="tenant-name" className="text-sm font-medium">
                    {t('Your full name')}
                  </label>
                  <Input
                    className="mt-2"
                    id="tenant-name"
                    name="fullName"
                    required
                    maxLength={100}
                    pattern={String.raw`.*\S.*`}
                    autoComplete="name"
                    disabled={state === 'saving'}
                  />
                </div>
              )}
              <div>
                <label
                  htmlFor="tenant-password"
                  className="text-sm font-medium"
                >
                  {preview.mode === 'setup'
                    ? t('Choose a password')
                    : t('Your current password')}
                </label>
                <Input
                  className="mt-2"
                  id="tenant-password"
                  name="password"
                  type="password"
                  autoComplete={
                    preview.mode === 'setup'
                      ? 'new-password'
                      : 'current-password'
                  }
                  minLength={8}
                  maxLength={64}
                  required
                  disabled={state === 'saving'}
                />
              </div>
              {preview.mode === 'setup' && (
                <div>
                  <label
                    htmlFor="tenant-confirm"
                    className="text-sm font-medium"
                  >
                    {t('Confirm password')}
                  </label>
                  <Input
                    className="mt-2"
                    id="tenant-confirm"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={64}
                    required
                    disabled={state === 'saving'}
                  />
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-danger-11">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={state === 'saving'}
              >
                {state === 'saving' ? t('Joining…') : t('Accept invitation')}
              </Button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
