import {
  HOSTED_PARTNER_STARTER_MONTHLY_CREDITS,
  MAX_FULL_NAME_LENGTH,
} from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useHostedAuthSession } from '@/features/hosted-onboarding/auth-session';
import { formatCreditUnits, parseCreditInput } from '@/lib/hosted-credit-units';

import {
  createManualAccount,
  readManualPartnerCourses,
  ManualAccount,
  ManualAccountError,
  ManualAccountInput,
} from './manual-accounts-api';
import {
  subscriptionGraceEnd,
  subscriptionUtcInput,
  subscriptionUtcLabel,
} from './subscription-dates';

type Session = ReturnType<typeof useHostedAuthSession>;
const selectStyle =
  'mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm';
const credits = {
  training: 300,
  starter: 300,
  team: 1200,
  scale: 4000,
};
function initialExpiry(kind: 'partner' | 'client') {
  if (kind === 'client') return '';
  const now = new Date(),
    expiry = new Date(now);
  expiry.setUTCDate(1);
  expiry.setUTCFullYear(now.getUTCFullYear() + 1);
  const lastDay = new Date(
    Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0),
  ).getUTCDate();
  expiry.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return expiry.toISOString().slice(0, 16);
}
function message(error: unknown) {
  if (error instanceof ManualAccountError) {
    if (/EMAIL|IDENTITY|EXISTS|ACCOUNT_UNAVAILABLE/.test(error.code))
      return t(
        'This email already belongs to an account. Use account lookup to manage it; this form does not replace an existing password or membership.',
      );
    if (/EXPIR|DATE/.test(error.code))
      return t('Choose a future expiration date within the next 36 months.');
    if (/COURSE/.test(error.code))
      return t(
        'The selected course is unavailable. Refresh the course list or create the account without a course and enroll it later.',
      );
    if (/SESSION|ACCESS|OPERATOR/.test(error.code))
      return t(
        'Your operator session could not be confirmed. Sign in again before continuing.',
      );
  }
  return t(
    'Creation was not confirmed. Keep the same details and retry to check the saved result before creating another account.',
  );
}
export function ManualAccountForm({
  session,
  kind,
  onCreated,
}: {
  session: Session;
  kind: 'partner' | 'client';
  onCreated?: (account: ManualAccount) => void;
}) {
  const [plan, setPlan] = useState<'training' | 'starter' | 'team' | 'scale'>(
    kind === 'partner' ? 'training' : 'starter',
  );
  const [partnerPackage, setPartnerPackage] = useState<
    'starter' | 'core' | 'launch'
  >('core');
  const partnerStarter = kind === 'partner' && partnerPackage === 'starter';
  const starterCredits = HOSTED_PARTNER_STARTER_MONTHLY_CREDITS / 100;
  const [monthly, setMonthly] = useState(300),
    [expiry, setExpiry] = useState(() => initialExpiry(kind)),
    [expiryChanged, setExpiryChanged] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [created, setCreated] = useState<ManualAccount | null>(null),
    [showPassword, setShowPassword] = useState(false);
  const mounted = useRef(true),
    locked = useRef(false),
    attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const courses = useQuery({
    queryKey: ['manual-account-courses', session.epoch],
    enabled: kind === 'partner' && session.kind === 'user',
    retry: false,
    gcTime: 0,
    queryFn: () => readManualPartnerCourses(session),
  });
  const expiresAt = subscriptionUtcInput(expiry),
    grace = expiresAt ? subscriptionGraceEnd(expiresAt) : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      locked.current ||
      !confirmed ||
      !expiresAt ||
      parseCreditInput(String(monthly)) === null ||
      (partnerStarter && monthly > starterCredits)
    )
      return;
    const form = event.currentTarget,
      values = new FormData(form);
    const common = {
      companyName: String(values.get('companyName') ?? '').trim(),
      fullName: String(values.get('fullName') ?? '').trim(),
      email: String(values.get('email') ?? '')
        .trim()
        .toLowerCase(),
      password: String(values.get('password') ?? ''),
      ...(kind === 'partner' && !expiryChanged ? {} : { expiresAt }),
      monthlyCredits: parseCreditInput(String(monthly))!,
      reason: String(values.get('reason') ?? '').trim(),
    };
    const details =
      kind === 'partner'
        ? {
            ...common,
            kind: 'partner' as const,
            planId: 'training' as const,
            partner: {
              package: partnerPackage,
              ...(!partnerStarter && values.get('courseId')
                ? { courseId: String(values.get('courseId')) }
                : {}),
              approve: approved,
            },
          }
        : {
            ...common,
            kind: 'client' as const,
            planId: plan as 'starter' | 'team' | 'scale',
          };
    const fingerprint = JSON.stringify(details);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError('');
    setCreated(null);
    try {
      const result = await createManualAccount(session, {
        ...details,
        requestKey: attempt.current.key,
      } as ManualAccountInput);
      if (!mounted.current) return;
      form.reset();
      attempt.current = null;
      setConfirmed(false);
      setApproved(false);
      setPartnerPackage('core');
      setMonthly(kind === 'partner' ? 300 : credits[plan]);
      setShowPassword(false);
      setExpiry(initialExpiry(kind));
      setExpiryChanged(false);
      setCreated(result.account);
      onCreated?.(result.account);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby={`manual-${kind}-heading`}
      className="max-w-3xl border-b border-gray-6 pb-8"
    >
      <h2 id={`manual-${kind}-heading`} className="text-lg font-semibold">
        {kind === 'partner'
          ? t('Add Partner manually')
          : t('Add client manually')}
      </h2>
      <p className="mt-2 text-sm leading-6 text-gray-11">
        {t(
          'Create a new account with an initial password and a manually funded hosting term. Verify payment or your authorization before granting access. No email or Stripe charge is sent.',
        )}
      </p>
      <form onSubmit={(event) => void submit(event)} className="mt-5">
        <fieldset disabled={busy} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              {t('Company / workspace name')}
              <Input
                className="mt-2"
                name="companyName"
                required
                maxLength={120}
                autoComplete="organization"
              />
            </label>
            <label className="block text-sm">
              {t('Full name')}
              <Input
                className="mt-2"
                name="fullName"
                required
                maxLength={MAX_FULL_NAME_LENGTH}
                autoComplete="name"
              />
            </label>
            <label className="block text-sm">
              {t('Email')}
              <Input
                className="mt-2"
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="off"
              />
            </label>
            <div>
              <label
                className="block text-sm"
                htmlFor={`manual-${kind}-password`}
              >
                {t('Initial password')}
              </label>
              <Input
                id={`manual-${kind}-password`}
                className="mt-2"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                maxLength={64}
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => setShowPassword((value) => !value)}
                aria-pressed={showPassword}
              >
                {showPassword ? t('Hide password') : t('Show password')}
              </Button>
            </div>
          </div>
          <p className="text-sm text-gray-11">
            {t(
              'Share the initial password privately. Existing accounts and passwords are never overwritten by this form.',
            )}
          </p>
          {kind === 'client' ? (
            <label className="block text-sm">
              {t('Client plan')}
              <select
                name="planId"
                value={plan}
                className={selectStyle}
                onChange={(event) => {
                  const value = event.target.value as
                    | 'starter'
                    | 'team'
                    | 'scale';
                  setPlan(value);
                  setMonthly(credits[value]);
                }}
              >
                <option value="starter">
                  {t('Starter · 10 users · 300 monthly Credits')}
                </option>
                <option value="team">
                  {t('Growth · 30 users · 1,200 monthly Credits')}
                </option>
                <option value="scale">
                  {t('Scale · 100 users · 4,000 monthly Credits')}
                </option>
              </select>
            </label>
          ) : (
            <>
              <p className="text-sm font-medium">
                {t('Partner workspace · 1 user · clients subscribe separately')}
              </p>
              <label className="block text-sm">
                {t('Partner package')}
                <select
                  name="package"
                  className={selectStyle}
                  value={partnerPackage}
                  onChange={(event) => {
                    const value = event.target.value as
                      | 'starter'
                      | 'core'
                      | 'launch';
                    setPartnerPackage(value);
                    setMonthly(value === 'starter' ? starterCredits : 300);
                  }}
                >
                  <option value="starter">
                    {t('Starter · internal only · 35 monthly Credits')}
                  </option>
                  <option value="core">{t('Core')}</option>
                  <option value="launch">{t('Guided')}</option>
                </select>
              </label>
              <label className="block text-sm">
                {t('Partner course')}
                <select
                  name="courseId"
                  className={selectStyle}
                  defaultValue=""
                  disabled={partnerStarter}
                >
                  <option value="">{t('Assign a course later')}</option>
                  {courses.data?.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.content.title}
                    </option>
                  ))}
                </select>
              </label>
              {partnerStarter && (
                <p className="text-sm leading-6 text-gray-11">
                  {t(
                    'Partner Starter is assigned internally by platform admins. It has a 35-Credit monthly cap, with no rollover or automatic overages. Training is not included.',
                  )}
                </p>
              )}
              {!partnerStarter && courses.isError && (
                <p role="alert" className="text-sm">
                  {t(
                    'Courses could not load. You can create the account without a course and enroll it later.',
                  )}{' '}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void courses.refetch()}
                  >
                    {t('Retry courses')}
                  </Button>
                </p>
              )}
              {!partnerStarter && courses.data?.length === 0 && (
                <p className="text-sm text-gray-11">
                  {t('No published Partner courses yet.')}{' '}
                  <Link
                    className="text-accent-11 underline underline-offset-4"
                    to="/learn"
                  >
                    {t('Manage courses in Learning')}
                  </Link>
                </p>
              )}
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              {t('Expiration / renewal due (UTC)')}
              <Input
                className="mt-2"
                type="datetime-local"
                required
                value={expiry}
                onChange={(event) => {
                  setExpiry(event.target.value);
                  setExpiryChanged(true);
                }}
                aria-describedby={`manual-${kind}-expiry-help`}
              />
            </label>
            <label className="block text-sm">
              {t('Monthly Credits')}
              <Input
                className="mt-2"
                type="number"
                min={0}
                max={partnerStarter ? starterCredits : 10_000}
                step={0.01}
                required
                value={monthly}
                onChange={(event) => setMonthly(Number(event.target.value))}
              />
            </label>
          </div>
          <p
            id={`manual-${kind}-expiry-help`}
            className="text-sm leading-6 text-gray-11"
          >
            {kind === 'partner' && (
              <>
                {t(
                  'Defaults to one year from creation. You can choose a different expiration date.',
                )}{' '}
              </>
            )}
            {t(
              'Monthly allowances stop at the expiration date. Remaining Credits can be used during the 15-day grace period; runtime is then suspended. New allowances do not accumulate for missed months.',
            )}
            {grace && (
              <>
                {' '}
                {t('Automatic cutoff:')}{' '}
                <strong>{subscriptionUtcLabel(grace)}</strong>.
              </>
            )}
          </p>
          <label className="block text-sm">
            {t('Manual payment reference / authorization reason')}
            <Input
              className="mt-2"
              name="reason"
              required
              minLength={3}
              maxLength={500}
              placeholder={t(
                'Receipt reference or reason this term is authorized',
              )}
            />
          </label>
          {kind === 'partner' && (
            <label className="flex items-start gap-3 text-sm leading-6">
              <input
                className="mt-1 size-4 shrink-0 accent-accent-9"
                type="checkbox"
                checked={approved}
                onChange={(event) => setApproved(event.target.checked)}
              />
              <span>
                {t(
                  'Approve operational Partner access now. Course completion, certification and client assignments remain separate decisions.',
                )}
              </span>
            </label>
          )}
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              className="mt-1 size-4 shrink-0 accent-accent-9"
              type="checkbox"
              required
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {t(
                'I verified the manual payment or authorization for this account and the hosting term above.',
              )}
            </span>
          </label>
          <Button type="submit" disabled={busy || !confirmed || !expiresAt}>
            {busy
              ? t('Creating account…')
              : kind === 'partner'
              ? t('Create Partner account')
              : t('Create client account')}
          </Button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-sm">
          {error}
        </p>
      )}
      {created && (
        <div
          role="status"
          className="mt-5 space-y-2 border-t border-gray-6 pt-4 text-sm"
        >
          <p className="font-medium">
            {t('Account created:')} {created.name}
          </p>
          <p className="break-words">
            {created.email} · {formatCreditUnits(created.monthlyCredits)}{' '}
            {t('monthly Credits')} · {created.seats} {t('user limit')}
          </p>
          <p>
            {t('Expiration / renewal due:')}{' '}
            {subscriptionUtcLabel(created.expiresAt)}
            <br />
            {t('Automatic cutoff:')} {subscriptionUtcLabel(created.graceEndsAt)}
          </p>
          <p>
            {t(
              'The person can now sign in with the email and initial password you entered. Sign out of your admin account before testing their login.',
            )}
          </p>
          <p>
            <Link
              className="text-accent-11 underline underline-offset-4"
              to="/learn"
            >
              {t('Manage learning')}
            </Link>{' '}
            ·{' '}
            <Link
              className="text-accent-11 underline underline-offset-4"
              to="/platform/billing/subscriptions"
            >
              {t('Assign training and manage renewal dates')}
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}
