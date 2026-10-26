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
  method: z.literal('manual_recovery'),
  emailOwnershipVerified: z.literal(false),
});
async function publicRequest(
  path: string,
  body: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(
    API_URL + '/v1/hosting/account-recovery/' + path,
    {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!response.ok) throw new Error('Setup could not be confirmed');
  return response.json();
}
export function AccountRecoveryPage() {
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
      setError(t('Choose a new password with 8–64 characters.'));
      return;
    }
    locked.current = true;
    setState('saving');
    setError(null);
    form.reset();
    try {
      const response = z
        .object({
          completed: z.literal(true),
          method: z.literal('manual_recovery'),
          emailOwnershipVerified: z.literal(false),
        })
        .safeParse(await publicRequest('redeem', { token, password }));
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
        aria-labelledby="account-recovery-heading"
      >
        <h1 id="account-recovery-heading" className="text-xl font-semibold">
          {state === 'complete'
            ? t('Your password was reset')
            : t('Recover your Sydekyks account')}
        </h1>
        <p className="mt-3 text-sm leading-6 text-gray-11">
          {t(
            'The Sydekyks team issued this private recovery link after checking your identity. It expires within 30 minutes. Resetting your password closes previous sessions; your memberships, courses and Credits stay unchanged.',
          )}
        </p>
        {state === 'loading' && (
          <p role="status" className="mt-6 text-sm">
            {t('Checking your recovery link…')}
          </p>
        )}
        {state === 'unavailable' && (
          <div role="status" className="mt-6 space-y-4 text-sm leading-6">
            <p>
              {token
                ? t(
                    'Recovery could not be confirmed. The link may have expired, been replaced or already been used. If you already reset your password, sign in; otherwise contact the Sydekyks team.',
                  )
                : t(
                    'Reopen the original private recovery link. It is removed from the address bar and is not kept after a reload. Contact the Sydekyks team if you need another link.',
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
                'Your new password is saved and previous sessions are closed. Sign in with your new password. Your existing memberships, courses and Credits were preserved.',
              )}
            </p>
            <Link
              className="text-accent-11 underline underline-offset-4"
              to="/sign-in"
            >
              {t('Sign in')}
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
                <label
                  htmlFor="recovery-password"
                  className="text-sm font-medium"
                >
                  {t('Choose a new password')}
                </label>
                <Input
                  id="recovery-password"
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
                <label
                  htmlFor="recovery-confirm"
                  className="text-sm font-medium"
                >
                  {t('Confirm password')}
                </label>
                <Input
                  id="recovery-confirm"
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
                  ? t('Resetting password…')
                  : t('Reset password')}
              </Button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
