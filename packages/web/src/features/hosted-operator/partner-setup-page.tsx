import { PasswordType } from '@activepieces/shared';
import { t } from 'i18next';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { API_URL } from '@/lib/api';
import {
  forgetPartnerSetupSecret,
  getPartnerSetupSecret,
} from '@/lib/partner-setup-secret';

const Preview = z.object({
  email: z.string(),
  expiresAt: z.string(),
  method: z.literal('operator'),
  emailOwnershipVerified: z.literal(false),
});
async function publicRequest(
  path: string,
  body: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(API_URL + '/v1/hosting/partner-setup/' + path, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error('Setup could not be confirmed');
  return response.json();
}
export function PartnerSetupPage() {
  const [token] = useState(getPartnerSetupSecret);
  const [preview, setPreview] = useState<z.infer<typeof Preview> | null>(null);
  const [state, setState] = useState<
    'loading' | 'ready' | 'saving' | 'complete' | 'unavailable'
  >(token ? 'loading' : 'unavailable');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    if (token)
      publicRequest('inspect', { token }, abort.signal)
        .then((raw) => {
          const parsed = Preview.safeParse(raw);
          if (!parsed.success) throw new Error('Setup unavailable');
          if (mounted.current && !abort.signal.aborted) {
            setPreview(parsed.data);
            setState('ready');
          }
        })
        .catch(() => {
          if (mounted.current && !abort.signal.aborted) {
            setState('unavailable');
            forgetPartnerSetupSecret();
          }
        });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || state !== 'ready' || !token) return;
    const form = event.currentTarget,
      data = new FormData(form),
      password = String(data.get('password') ?? '');
    if (password !== data.get('confirmPassword')) {
      setError(t('The passwords do not match. Enter them again.'));
      return;
    }
    if (!PasswordType.safeParse(password).success) {
      setError(t('Choose a password with 8–64 characters.'));
      return;
    }
    locked.current = true;
    setState('saving');
    setError(null);
    const fullName = String(data.get('fullName') ?? '').trim();
    form.reset();
    try {
      const response = z
        .object({
          completed: z.literal(true),
          status: z.literal('awaiting_partner_approval'),
          method: z.literal('operator'),
          emailOwnershipVerified: z.literal(false),
        })
        .safeParse(
          await publicRequest('redeem', { token, password, fullName }),
        );
      if (!response.success) throw new Error('Setup not confirmed');
      forgetPartnerSetupSecret();
      if (mounted.current) setState('complete');
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
        aria-labelledby="partner-setup-heading"
      >
        <h1 id="partner-setup-heading" className="text-xl font-semibold">
          {state === 'complete'
            ? t('Your password is set')
            : t('Set up your Sydekyks account')}
        </h1>
        <p className="mt-3 text-sm leading-6 text-gray-11">
          {t(
            'This private setup link was issued by a Sydekyks operator. It records manual admission; it does not verify ownership of an email inbox or grant partner access.',
          )}
        </p>
        {state === 'loading' && (
          <p role="status" className="mt-6 text-sm">
            {t('Checking your setup link…')}
          </p>
        )}
        {state === 'unavailable' && (
          <div role="status" className="mt-6 space-y-4 text-sm leading-6">
            <p>
              {token
                ? t(
                    'This setup could not be confirmed. The link may have expired, been replaced or already been used. If you already set a password, try signing in; otherwise ask the operator for a new link.',
                  )
                : t(
                    'Reopen the original private setup link from the operator. For your privacy the link is removed from the address bar and is not kept after a reload.',
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
          <div role="status" className="mt-6 space-y-4 text-sm leading-6">
            <p>
              {t(
                'Your account was manually admitted by an operator. Ask the Sydekyks team to approve partner access for this account, then sign in with the password you chose. Client workspace assignments are a separate step.',
              )}
            </p>
            <Link
              className="text-accent-11 underline underline-offset-4"
              to="/sign-in"
            >
              {t('Sign in after approval')}
            </Link>
          </div>
        )}
        {preview && (state === 'ready' || state === 'saving') && (
          <>
            <p className="mt-5 break-all text-sm font-medium">
              {preview.email}
            </p>
            <form
              onSubmit={submit}
              className="mt-5 space-y-4"
              aria-busy={state === 'saving'}
            >
              <div>
                <label htmlFor="setup-name" className="text-sm font-medium">
                  {t('Your full name')}
                </label>
                <Input
                  id="setup-name"
                  className="mt-2"
                  name="fullName"
                  autoComplete="name"
                  required
                  maxLength={100}
                  pattern={String.raw`.*\S.*`}
                  disabled={state === 'saving'}
                />
              </div>
              <div>
                <label htmlFor="setup-password" className="text-sm font-medium">
                  {t('Choose a password')}
                </label>
                <Input
                  id="setup-password"
                  className="mt-2"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={64}
                  disabled={state === 'saving'}
                />
                <p className="mt-2 text-sm text-gray-11">
                  {t('Use 8–64 characters. Only you choose this password.')}
                </p>
              </div>
              <div>
                <label htmlFor="setup-confirm" className="text-sm font-medium">
                  {t('Confirm password')}
                </label>
                <Input
                  id="setup-confirm"
                  className="mt-2"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={64}
                  disabled={state === 'saving'}
                />
              </div>
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
                {state === 'saving'
                  ? t('Setting password…')
                  : t('Set password and continue')}
              </Button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
