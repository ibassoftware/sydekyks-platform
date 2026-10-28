import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { FormEvent, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useHostedAuthSession } from '@/features/hosted-onboarding/auth-session';
import { creditUnitsInput, parseCreditInput } from '@/lib/hosted-credit-units';

import {
  ManualAccountError,
  readManualAccount,
  readManualPartnerCourses,
  enrollManualPartner,
  renewManualAccount,
} from './manual-accounts-api';
import {
  subscriptionGraceEnd,
  subscriptionUtcInput,
  subscriptionUtcLabel,
} from './subscription-dates';

type Session = ReturnType<typeof useHostedAuthSession>;
export function ManualTermControls({
  session,
  platformId,
  onSaved,
}: {
  session: Session;
  platformId: string;
  onSaved: () => void;
}) {
  const term = useQuery({
    queryKey: ['manual-account-term', session.epoch, platformId],
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      try {
        return (await readManualAccount(session, platformId)).account;
      } catch (error) {
        if (
          error instanceof ManualAccountError &&
          error.code === 'HOSTING_MANUAL_ACCOUNT_NOT_FOUND'
        )
          return null;
        throw error;
      }
    },
  });
  const [expiry, setExpiry] = useState(''),
    [monthly, setMonthly] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const locked = useRef(false),
    mounted = useRef(true),
    attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [courseId, setCourseId] = useState('');
  const courseAttempt = useRef<{ courseId: string; key: string } | null>(null);
  const courses = useQuery({
    queryKey: ['manual-account-courses', session.epoch],
    retry: false,
    gcTime: 0,
    enabled: term.data?.kind === 'partner' && !term.data.enrollmentId,
    queryFn: () => readManualPartnerCourses(session),
  });
  const until = subscriptionUtcInput(expiry),
    cutoff = until ? subscriptionGraceEnd(until) : null;
  if (term.isPending)
    return (
      <p className="text-sm text-gray-11" role="status">
        {t('Checking manual funding…')}
      </p>
    );
  if (term.isError)
    return (
      <p role="alert" className="text-sm">
        {t('Manual funding could not be checked.')}{' '}
        <Button variant="ghost" size="sm" onClick={() => void term.refetch()}>
          {t('Retry manual funding')}
        </Button>
      </p>
    );
  if (!term.data) return null;
  const account = term.data;
  const expired = Date.parse(account.expiresAt) <= Date.now();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !until ||
      !confirmed ||
      !expired ||
      locked.current ||
      (monthly !== '' && parseCreditInput(monthly) === null)
    )
      return;
    const form = event.currentTarget,
      values = new FormData(form),
      details = {
        expectedRevision: account!.revision,
        expiresAt: until,
        monthlyCredits:
          monthly !== '' ? parseCreditInput(monthly)! : account!.monthlyCredits,
        reason: String(values.get('reason') ?? '').trim(),
      };
    const fingerprint = JSON.stringify(details);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await renewManualAccount(session, platformId, {
        ...details,
        requestKey: attempt.current.key,
      });
      if (!mounted.current) return;
      attempt.current = null;
      form.reset();
      setExpiry('');
      setMonthly('');
      setConfirmed(false);
      setNotice(
        t('New manual hosting term recorded. Refresh dates to review access.'),
      );
      await term.refetch();
      onSaved();
    } catch {
      if (mounted.current)
        setError(
          t(
            'Renewal was not confirmed. Refresh the funding state before retrying. A changed term, active term or Stripe billing needs review.',
          ),
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function assignCourse() {
    if (!courseId || !account || account.enrollmentId || locked.current) return;
    if (!courseAttempt.current || courseAttempt.current.courseId !== courseId)
      courseAttempt.current = { courseId, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await enrollManualPartner(session, platformId, {
        courseId,
        expectedRevision: account.revision,
        requestKey: courseAttempt.current.key,
      });
      if (!mounted.current) return;
      courseAttempt.current = null;
      setCourseId('');
      setNotice(
        t('Partner course assigned. No additional Credits were issued.'),
      );
      await term.refetch();
      onSaved();
    } catch {
      if (mounted.current)
        setError(
          t(
            'Course assignment was not confirmed. Refresh this workspace and check its enrollment before retrying.',
          ),
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="manual-renewal-heading"
      className="space-y-4 border-t border-gray-6 pt-6"
    >
      <h2 id="manual-renewal-heading" className="text-lg font-semibold">
        {t('Manual hosting funding')}
      </h2>
      <p className="text-sm leading-6 text-gray-11">
        {t('Monthly Credits are funded through')}{' '}
        <strong>{subscriptionUtcLabel(account.expiresAt)}</strong>.{' '}
        {t(
          'Changing the renewal due date above does not fund another monthly allowance.',
        )}
      </p>
      <p className="text-sm leading-6 text-gray-11">
        {t(
          'After the current funded term expires, record a verified manual renewal here. The new term starts now; it does not backfill missed months or reset previous charges and holds.',
        )}
      </p>
      {account.kind === 'partner' && !account.enrollmentId && (
        <div className="space-y-3 border-y border-gray-6 py-4">
          <h3 className="font-medium">{t('Assign Partner training')}</h3>
          <p className="text-sm text-gray-11">
            {t(
              'Attach a published Partner course to this funded workspace. This does not issue another hosting allowance or certify the Partner.',
            )}
          </p>
          <label htmlFor="manual-partner-course" className="block text-sm">
            {t('Published Partner course')}
          </label>
          <select
            id="manual-partner-course"
            className="block w-full rounded-md border border-gray-6 bg-gray-1 p-2 text-sm"
            value={courseId}
            disabled={busy || expired || courses.isPending}
            onChange={(event) => setCourseId(event.target.value)}
          >
            <option value="">{t('Choose a course')}</option>
            {courses.data?.map((course) => (
              <option key={course.id} value={course.id}>
                {course.content.title}
              </option>
            ))}
          </select>
          {courses.isError && (
            <p role="alert" className="text-sm">
              {t('Partner courses could not load.')}{' '}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void courses.refetch()}
              >
                {t('Retry courses')}
              </Button>
            </p>
          )}
          {courses.data?.length === 0 && (
            <p className="text-sm text-gray-11">
              {t(
                'Publish a global Partner course in Learning before assigning it here.',
              )}
            </p>
          )}
          <Button
            disabled={busy || expired || !courseId}
            onClick={() => void assignCourse()}
          >
            {t('Assign Partner course')}
          </Button>
        </div>
      )}
      {!expired && (
        <p className="text-sm text-gray-11">
          {t(
            'The existing funded term is still active. A second term is unavailable until it expires.',
          )}
        </p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || !expired} className="space-y-4">
          <label className="block text-sm">
            {t('New expiration / renewal due (UTC)')}
            <Input
              className="mt-2"
              type="datetime-local"
              required
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            {t('New monthly Credits')}
            <Input
              className="mt-2"
              type="number"
              min={0}
              max={10_000}
              step={0.01}
              placeholder={creditUnitsInput(account.monthlyCredits)}
              value={monthly}
              onChange={(event) => setMonthly(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            {t('Payment reference / authorization reason')}
            <Input
              className="mt-2"
              name="reason"
              required
              minLength={3}
              maxLength={500}
            />
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              className="mt-1 size-4 shrink-0 accent-accent-9"
              type="checkbox"
              required
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {t(
                'I verified the payment or authorization for this new hosting term.',
              )}
            </span>
          </label>
          {cutoff && (
            <p className="text-sm">
              {t('Automatic cutoff after remaining-Credits grace:')}{' '}
              {subscriptionUtcLabel(cutoff)}
            </p>
          )}
          <Button
            type="submit"
            disabled={busy || !expired || !confirmed || !until}
          >
            {busy ? t('Recording renewal…') : t('Record manual renewal')}
          </Button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
