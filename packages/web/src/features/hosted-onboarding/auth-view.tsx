import {
  HostedOnboardingOffer,
  HostedOnboardingStatus,
  MAX_FULL_NAME_LENGTH,
} from '@activepieces/shared';
import { t } from 'i18next';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useRef } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type AuthStage =
  | 'email'
  | 'code'
  | 'password'
  | 'verification'
  | 'details'
  | 'ready';
export type HostedAuthViewProps = {
  stage: AuthStage;
  mode: 'signup' | 'signin';
  offer?: HostedOnboardingOffer;
  status?: HostedOnboardingStatus;
  email: string;
  pending: boolean;
  loading: boolean;
  canRefresh?: boolean;
  error: string | null;
  notice: string | null;
  cooldown: number;
  captchaReady: boolean;
  challenge?: ReactNode;
  brand: ReactNode;
  legalLinks?: { label: string; url: string }[];
  onSubmit: (data: FormData) => void;
  onStage: (stage: AuthStage) => void;
  onResend: (email?: string) => void;
  onRefresh: () => void;
  onExit: () => void;
  onContinue: () => void;
  onBilling: () => void;
};
export function HostedAuthView(props: HostedAuthViewProps) {
  const {
    stage,
    mode,
    offer,
    status,
    email,
    pending,
    loading,
    canRefresh = true,
    error,
    notice,
    cooldown,
    captchaReady,
    challenge,
    brand,
    onSubmit,
    onStage,
    onResend,
    onRefresh,
    onExit,
    onContinue,
    onBilling,
  } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [props.stage]);
  const formRef = useRef<HTMLFormElement>(null);
  const emailStage = stage === 'email';
  const ready = stage === 'ready';
  const details = stage === 'details';
  const verification = stage === 'verification';
  const code = stage === 'code';
  const password = stage === 'password';
  function resend() {
    const field = formRef.current?.querySelector<HTMLInputElement>(
      'input[name="email"]',
    );
    if (field && !field.reportValidity()) return;
    onResend(verification ? field?.value : email);
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  };
  const unavailable = !offer?.emailCodesAvailable;
  return (
    <main className="min-h-dvh bg-gray-2 px-4 py-6 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-[60rem]">
        <header className="mb-8 flex items-center justify-between gap-4">
          {brand}
          <span className="text-sm text-gray-11">{t('Hosted workspace')}</span>
        </header>
        <div className="grid items-start gap-8 md:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] md:gap-12">
          <section
            aria-labelledby="hosted-auth-title"
            className="rounded-2xl border bg-gray-1 p-5 sm:p-8"
          >
            <h1
              ref={headingRef}
              tabIndex={-1}
              id="hosted-auth-title"
              className="text-xl font-medium focus:outline-none"
            >
              {ready
                ? t('Your workspace')
                : details
                ? t('Set up your workspace')
                : verification
                ? t('Verify your email')
                : code
                ? t('Check your inbox')
                : password
                ? t('Sign in with password')
                : mode === 'signup'
                ? t('Start your hosted trial')
                : t('Sign in to your workspace')}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-11">
              {ready && status
                ? t(
                    'Your current access is verified by the server. Signing in never restarts a trial.',
                  )
                : ready
                ? t(
                    'Your workspace access is checked on the server. Signing in never restarts a trial.',
                  )
                : details
                ? t(
                    'Your email is verified. Add your name to continue to your workspace. Existing memberships and trial eligibility are checked on the server.',
                  )
                : verification
                ? t(
                    'Enter the complete verification code from your email and choose a new password to secure your account.',
                  )
                : code
                ? t(
                    'If this address can sign in, a six-digit code was sent to {email}. Codes expire after 10 minutes.',
                    { email },
                  )
                : password
                ? t(
                    'Use your existing account password. You can also sign in with an email code.',
                  )
                : t(
                    'Use your email to create an account or return to an existing workspace. We’ll send a sign-in code.',
                  )}
            </p>
            {loading && (
              <p role="status" className="mt-6 text-sm text-gray-11">
                {t('Loading hosted setup…')}
              </p>
            )}
            {error && (
              <Alert variant="destructive" className="mt-5">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {notice && (
              <p role="status" className="mt-4 text-sm text-gray-11">
                {notice}
              </p>
            )}
            {!loading && offer && emailStage && unavailable && (
              <Alert className="mt-5">
                <AlertDescription>
                  {t(
                    'New hosted signup is unavailable. Email delivery and verification must be configured before codes can be sent. Existing members can use their password.',
                  )}
                </AlertDescription>
              </Alert>
            )}
            {!ready && (
              <form
                ref={formRef}
                onSubmit={submit}
                className="mt-6 space-y-4"
                aria-busy={pending}
              >
                {(emailStage || password || verification) && (
                  <Field
                    label={t('Email')}
                    name="email"
                    type="email"
                    autoComplete="email"
                    defaultValue={email}
                    disabled={pending}
                    required
                  />
                )}
                {code && (
                  <Field
                    label={t('Sign-in code')}
                    name="code"
                    type="text"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    disabled={pending}
                    required
                    description={t(
                      'Enter all six digits, including any leading zero.',
                    )}
                  />
                )}
                {password && (
                  <Field
                    label={t('Password')}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    maxLength={64}
                    disabled={pending}
                    required
                  />
                )}
                {verification && (
                  <>
                    <Field
                      label={t('Verification code')}
                      name="code"
                      type="text"
                      autoComplete="one-time-code"
                      maxLength={128}
                      disabled={pending}
                      required
                      description={t(
                        'Paste the entire code, including hyphens. This is different from a six-digit sign-in code.',
                      )}
                    />
                    <Field
                      label={t('New password')}
                      name="newPassword"
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={64}
                      disabled={pending}
                      required
                      description={t(
                        'Use 8–64 characters. This replaces any password chosen before email verification.',
                      )}
                    />
                    <Field
                      label={t('Confirm new password')}
                      name="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={64}
                      disabled={pending}
                      required
                    />
                  </>
                )}
                {details && (
                  <>
                    <Field
                      label={t('Your full name')}
                      name="fullName"
                      type="text"
                      autoComplete="name"
                      pattern={String.raw`.*\S.*`}
                      maxLength={MAX_FULL_NAME_LENGTH}
                      disabled={pending}
                      required
                    />
                    <p className="text-sm text-gray-11">
                      {offer
                        ? t(
                            'If eligible, your {days}-day trial includes {credits} Credits. Managed AI is subject to service limits. The trial expires after this period; there is no ongoing free hosted tier.',
                            {
                              days: offer.trialDays,
                              credits: offer.trial.executions.toLocaleString(),
                            },
                          )
                        : t('Review the trial details before continuing.')}{' '}
                      {t('No payment is collected during this setup.')}
                    </p>
                  </>
                )}
                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    pending ||
                    loading ||
                    !offer ||
                    (emailStage &&
                      (unavailable || !captchaReady || cooldown > 0))
                  }
                  aria-busy={pending}
                >
                  {pending
                    ? t('Please wait…')
                    : emailStage
                    ? cooldown > 0
                      ? t('Send again in {seconds}s', { seconds: cooldown })
                      : t('Send sign-in code')
                    : code
                    ? t('Verify and continue')
                    : verification
                    ? t('Verify email and set password')
                    : details
                    ? t('Continue to workspace')
                    : t('Sign in')}
                  <ArrowRight className="ml-2 size-4" aria-hidden="true" />
                </Button>
              </form>
            )}
            {ready && status && (
              <div className="mt-6 space-y-4">
                <h2 className="break-words text-base font-semibold">
                  {status.platformName}
                </h2>
                <p className="text-sm">
                  {status.entitlementState === 'trial'
                    ? t('Trial active until {date}.', {
                        date: date(status.validUntil),
                      })
                    : status.entitlementState === 'training'
                    ? t('Training access through {date}.', {
                        date: date(status.validUntil),
                      })
                    : status.entitlementState === 'paid'
                    ? t('Paid access through {date}.', {
                        date: date(status.validUntil),
                      })
                    : status.entitlementState === 'expired'
                    ? t(
                        'Your access period has ended. A platform administrator can review paid plans in Billing.',
                      )
                    : t(
                        'This workspace is paused. Contact support or your platform administrator.',
                      )}
                </p>
                <Button className="w-full" onClick={onContinue}>
                  {t('Open workspace')}
                  <ArrowRight className="ml-2 size-4" aria-hidden="true" />
                </Button>
                {status.isAdmin && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={onBilling}
                  >
                    {t('Review billing & allowances')}
                  </Button>
                )}
              </div>
            )}
            {ready && !loading && !status && canRefresh && (
              <Button variant="outline" className="mt-5" onClick={onRefresh}>
                {t('Refresh access status')}
              </Button>
            )}
            {(code || verification) && (
              <div className="mt-5 space-y-3">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={
                    pending || cooldown > 0 || !captchaReady || unavailable
                  }
                  onClick={resend}
                >
                  {cooldown > 0
                    ? t('Resend in {seconds}s', { seconds: cooldown })
                    : t('Resend code')}
                </Button>
                {verification && (
                  <p className="text-xs text-gray-11">
                    {t(
                      'If verification succeeded but setup was interrupted, sign in with the new password you just set to resume.',
                    )}
                  </p>
                )}
              </div>
            )}
            {(emailStage || code || password || verification) && (
              <div className="mt-5 flex flex-wrap gap-x-5 gap-y-3 text-sm">
                {stage !== 'email' && (
                  <button
                    type="button"
                    disabled={pending}
                    className="inline-flex items-center gap-1 text-gray-11 hover:text-gray-12 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                    onClick={() => onStage('email')}
                  >
                    <ArrowLeft className="size-3.5" aria-hidden="true" />
                    {t('Use an email code')}
                  </button>
                )}
                {stage !== 'password' && (
                  <button
                    type="button"
                    disabled={pending}
                    className="text-accent-11 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                    onClick={() => onStage('password')}
                  >
                    {t('Use password')}
                  </button>
                )}
                {password && (
                  <button
                    type="button"
                    disabled={pending}
                    className="text-accent-11 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                    onClick={() => onStage('verification')}
                  >
                    {t('Finish email verification')}
                  </button>
                )}
              </div>
            )}
            {!!props.legalLinks?.length && !ready && (
              <p className="mt-5 text-xs leading-relaxed text-gray-11">
                {t('By continuing, you agree to our')}{' '}
                {props.legalLinks.map((link, index) => (
                  <span key={link.url}>
                    {index > 0 && ' · '}
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {link.label}
                    </a>
                  </span>
                ))}
              </p>
            )}
            {challenge && <div className="mt-5">{challenge}</div>}
            {!loading && !offer && canRefresh && (
              <Button variant="outline" className="mt-5" onClick={onRefresh}>
                {t('Reload setup details')}
              </Button>
            )}
            {(details || ready) && (
              <Button
                variant="link"
                className="mt-5 px-0"
                disabled={pending}
                onClick={onExit}
              >
                {t('Use another account')}
              </Button>
            )}
          </section>
          <aside
            aria-labelledby="hosted-trial-heading"
            className="space-y-6 py-1 text-sm"
          >
            <div>
              <h2 id="hosted-trial-heading" className="text-base font-semibold">
                {t('Try hosted Sydekyks')}
              </h2>
              <p className="mt-2 leading-relaxed text-gray-11">
                {t(
                  'A limited trial to build and run your first workflows. Choose a paid plan when you need to continue.',
                )}
              </p>
            </div>
            {offer && (
              <dl className="space-y-3">
                <Term
                  label={t('Trial duration')}
                  value={t('{days} days', { days: offer.trialDays })}
                />
                <Term
                  label={t('Credits')}
                  value={offer.trial.executions.toLocaleString()}
                />
                <Term
                  label={t('Workspace capacity')}
                  value={t('{users} member · {projects} project', {
                    users: offer.trial.users,
                    projects: offer.trial.projects,
                  })}
                />
              </dl>
            )}
            <div className="border-t pt-5">
              <h3 className="font-medium">{t('Bring your own key')}</h3>
              <p className="mt-2 leading-relaxed text-gray-11">
                {t(
                  'BYOK is included in every plan and uses Credits. Your provider bills AI usage separately. Managed AI is provided by Sydekyks and is subject to service limits. BYOK currently supports DeepSeek.',
                )}
              </p>
            </div>
            <p className="rounded-lg bg-gray-3 p-4 leading-relaxed text-gray-11">
              {t(
                'Hosted setup is under development. Live signup and payments have not been enabled. Self-hosting stays free.',
              )}
            </p>
          </aside>
        </div>
      </div>
    </main>
  );
}
function Field({
  label,
  description,
  ...input
}: React.ComponentProps<typeof Input> & {
  label: string;
  description?: string;
}) {
  const id = `hosted-auth-${input.name}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        {...input}
        id={id}
        aria-describedby={description ? `${id}-description` : undefined}
      />
      {description && (
        <p
          id={`${id}-description`}
          className="text-xs leading-relaxed text-gray-11"
        >
          {description}
        </p>
      )}
    </div>
  );
}
function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-gray-11">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}
function date(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
