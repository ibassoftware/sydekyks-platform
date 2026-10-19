import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';

import { operatorClientsQuery, useHostedOperatorAccess } from './operator-api';
import {
  OperatorSubscription,
  saveOperatorSubscription,
  subscriptionKey,
  SubscriptionUiError,
  useOperatorSubscription,
} from './subscription-api';
import {
  subscriptionGraceEnd,
  subscriptionUtcInput,
  subscriptionUtcLabel,
} from './subscription-dates';

export function SubscriptionAdminPage() {
  const access = useHostedOperatorAccess();
  return <SubscriptionScope key={access.session.epoch} access={access} />;
}
function SubscriptionScope({
  access,
}: {
  access: ReturnType<typeof useHostedOperatorAccess>;
}) {
  const [after, setAfter] = useState<string | null>(null),
    [target, setTarget] = useState(''),
    [savedNotice, setSavedNotice] = useState('');
  const clients = useQuery(
    operatorClientsQuery(access.session, after, access.allowed),
  );
  const selected = clients.data?.clients.find(
    (client) => client.platformId === target,
  );
  const state = useOperatorSubscription(
    access.session,
    target,
    access.allowed && !!selected,
  );
  if (!access.hosted)
    return (
      <p className="p-6">
        Renewal date controls are available on managed hosting.
      </p>
    );
  if (access.isPending)
    return (
      <p className="p-6" role="status">
        Checking operator access…
      </p>
    );
  if (!access.allowed)
    return (
      <p className="p-6" role="alert">
        Only Sydekyks operators can manage subscription dates.
      </p>
    );
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Subscription renewal dates</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
          Manage Partner and client due dates. Expiration means the renewal due
          date. Funded paid plans automatically include 15 days using remaining
          Credits only. Core training stays fixed unless you set an override;
          trials and assessment access keep their fixed windows.
        </p>
      </header>
      <section
        aria-labelledby="subscription-workspace-heading"
        className="space-y-3 border-y border-gray-6 py-5"
      >
        <h2 id="subscription-workspace-heading" className="font-semibold">
          Choose a Partner or client workspace
        </h2>
        <label htmlFor="subscription-workspace" className="block text-sm">
          Workspace
        </label>
        <select
          id="subscription-workspace"
          value={target}
          disabled={clients.isFetching}
          className="block w-full min-w-0 rounded-md border border-gray-6 bg-gray-1 p-2"
          onChange={(event) => {
            setTarget(event.target.value);
            setSavedNotice('');
          }}
        >
          <option value="">Select a workspace</option>
          {clients.data?.clients.map((client) => (
            <option key={client.platformId} value={client.platformId}>
              {client.name}
            </option>
          ))}
        </select>
        <p className="max-w-3xl text-sm leading-6 text-gray-11">
          Choose the Partner’s own workspace to manage their subscription. After
          its grace cutoff, the Partner also loses access to assigned client
          workspaces. A client’s date controls that client’s runtime.
        </p>
        {clients.isPending && (
          <p role="status">Loading authorized workspaces…</p>
        )}
        {clients.isError && (
          <p role="alert">
            Workspace names could not load. Refresh the list to try again.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={clients.isFetching}
            onClick={() => {
              setTarget('');
              void clients.refetch();
            }}
          >
            Refresh list
          </Button>
          {after && (
            <Button
              variant="outline"
              disabled={clients.isFetching}
              onClick={() => {
                setTarget('');
                setAfter(null);
              }}
            >
              First page
            </Button>
          )}
          {clients.data?.next && (
            <Button
              variant="outline"
              disabled={clients.isFetching}
              onClick={() => {
                setTarget('');
                setAfter(clients.data!.next);
              }}
            >
              Next page
            </Button>
          )}
        </div>
      </section>
      {!target && (
        <p className="text-sm text-gray-11">
          Select a workspace to review its funded access window and renewal
          date.
        </p>
      )}
      {selected && state.isPending && (
        <p role="status">Loading subscription dates…</p>
      )}
      {selected && state.isError && (
        <div role="alert">
          <p>
            Subscription dates could not load. Check your access and try again.
          </p>
          <Button
            variant="outline"
            className="mt-2"
            onClick={() => void state.refetch()}
          >
            Try again
          </Button>
        </div>
      )}
      {selected && state.data && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-11">
          <span>
            Status checked: {subscriptionUtcLabel(state.data.serverTime)}
          </span>
          <Button
            variant="outline"
            disabled={state.isFetching}
            onClick={() => void state.refetch()}
          >
            Refresh dates
          </Button>
        </div>
      )}
      {selected && !!savedNotice && <p role="status">{savedNotice}</p>}
      {selected && state.data && (
        <SubscriptionForm
          key={`${access.session.epoch}:${target}:${state.data.revision}`}
          state={state.data}
          session={access.session}
          onSaved={() =>
            setSavedNotice(
              'Subscription date saved. Credits and payment records were not changed.',
            )
          }
        />
      )}
    </main>
  );
}
const statuses = {
  unmanaged: 'Fixed access dates',
  current: 'Before renewal due date',
  grace: '15-day grace period',
  overdue: 'Overdue — runtime stopped',
  review_required: 'Review required',
};
export function SubscriptionForm({
  state,
  session,
  onSaved,
}: {
  state: OperatorSubscription;
  session: ReturnType<typeof useHostedOperatorAccess>['session'];
  onSaved: () => void;
}) {
  const cache = useQueryClient();
  const [date, setDate] = useState(state.renewalDueAt?.replace(/Z$/, '') ?? ''),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(true),
    lock = useRef(false),
    abort = useRef<AbortController | null>(null),
    pending = useRef<{ signature: string; requestKey: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  const proposed = subscriptionUtcInput(date),
    cutoff = proposed ? subscriptionGraceEnd(proposed) : null;
  const validReason = reason.trim().length > 0 && reason.trim().length <= 500;
  const paused = state.billingHold || state.accountStatus === 'suspended';
  const canReset = state.origin === 'override' && state.revision > 0;
  async function save(clear = false) {
    if (
      lock.current ||
      !validReason ||
      (!clear && (!proposed || !cutoff || !state.canManage)) ||
      (clear && !canReset)
    )
      return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    abort.current = new AbortController();
    const body = {
      expectedRevision: state.revision,
      renewalDueAt: clear ? null : proposed,
      reason: reason.trim(),
    };
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature)
      pending.current = { signature, requestKey: crypto.randomUUID() };
    try {
      const saved = await saveOperatorSubscription(
        session,
        state.scopePlatformId,
        abort.current.signal,
        { ...body, requestKey: pending.current.requestKey },
      );
      assertAuthSession(session);
      if (!mounted.current) return;
      onSaved();
      cache.setQueryData(
        subscriptionKey(session, state.scopePlatformId),
        saved,
      );
      for (const key of [
        'hosted-operator-clients',
        'hosted-billing',
        'hosted-onboarding-status',
        'hosted-operational-workspaces',
      ])
        void cache.invalidateQueries({ queryKey: [key] });
      setNotice(
        'Subscription date saved. Credits and payment records were not changed.',
      );
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof SubscriptionUiError && error.kind === 'conflict') {
        pending.current = null;
        setNotice(
          'This subscription changed. Refresh its dates before saving again.',
        );
        void cache.invalidateQueries({
          queryKey: subscriptionKey(session, state.scopePlatformId),
        });
      } else
        setNotice(
          'The subscription date could not be saved. Refresh to check access and the current dates before trying again.',
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void save();
  }
  return (
    <section
      aria-labelledby="subscription-selected-heading"
      className="space-y-5"
    >
      <header>
        <h2
          id="subscription-selected-heading"
          className="break-words text-xl font-semibold"
        >
          {state.name}
        </h2>
        <p className="mt-1 text-sm text-gray-11">
          Plan: {state.planId} · {statuses[state.state]}
        </p>
        <p className="mt-1 text-sm text-gray-11">
          Date rule:{' '}
          {state.origin === 'override'
            ? 'Operator override'
            : state.origin === 'paid_default'
            ? 'Automatic paid-plan renewal grace'
            : 'Fixed plan access window'}
        </p>
      </header>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-gray-11">
            Renewal due / subscription expiration
          </dt>
          <dd className="mt-1 break-words font-medium">
            {state.renewalDueAt
              ? subscriptionUtcLabel(state.renewalDueAt)
              : 'Fixed access window — no renewal due date'}
          </dd>
        </div>
        <div>
          <dt className="text-gray-11">Runtime grace cutoff</dt>
          <dd className="mt-1 break-words font-medium">
            {state.graceEndsAt
              ? subscriptionUtcLabel(state.graceEndsAt)
              : 'Fixed access window'}
          </dd>
        </div>
        <div>
          <dt className="text-gray-11">Current runtime date limit</dt>
          <dd className="mt-1 break-words font-medium">
            {subscriptionUtcLabel(state.effectiveRuntimeUntil)}
          </dd>
        </div>
      </dl>
      {paused && (
        <p role="status" className="text-sm font-medium">
          This account is suspended or on billing hold. A renewal date does not
          remove that restriction.
        </p>
      )}
      {state.state === 'review_required' && (
        <p role="status" className="text-sm">
          The funded entitlement changed. Review the current funded period
          before applying a date again; the old override does not transfer
          Credits.
        </p>
      )}
      {!state.canManage && (
        <p className="text-sm">
          A current funded training or paid period is required to set a renewal
          date. Trials and assessment access cannot be extended here. An
          existing manual date can still be removed.
        </p>
      )}
      {state.boundPeriod && (
        <p className="text-sm text-gray-11">
          Bound funded period:{' '}
          {subscriptionUtcLabel(state.boundPeriod.validFrom)} to{' '}
          {subscriptionUtcLabel(state.boundPeriod.originalValidUntil)}. Only its
          remaining Credits can be used.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4 border-t border-gray-6 pt-5">
        <div>
          <label
            htmlFor="renewal-due-date"
            className="block text-sm font-medium"
          >
            Renewal due date / expiration (UTC)
          </label>
          <Input
            id="renewal-due-date"
            type="datetime-local"
            step="0.001"
            value={date}
            disabled={busy || !state.canManage}
            onChange={(event) => setDate(event.target.value)}
            className="mt-2 w-full min-w-0"
            aria-describedby="renewal-date-help"
          />
          <p id="renewal-date-help" className="mt-2 text-sm text-gray-11">
            Enter UTC, not your local timezone. The cutoff is exactly 15 days
            later at the same UTC time.
          </p>
          {!!date && (!proposed || !cutoff) && (
            <p role="alert" className="mt-2 text-sm">
              Enter a valid UTC date and time.
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="subscription-reason"
            className="block text-sm font-medium"
          >
            Reason for this change
          </label>
          <Textarea
            id="subscription-reason"
            value={reason}
            maxLength={500}
            required
            disabled={busy || (!state.canManage && !canReset)}
            onChange={(event) => setReason(event.target.value)}
            className="mt-2"
          />
          <p className="mt-1 text-xs text-gray-11">
            Required for the operator audit record. {reason.length}/500
            characters.
          </p>
        </div>
        {proposed && cutoff && (
          <div
            className="space-y-2 border-y border-gray-6 py-4 text-sm"
            aria-live="polite"
          >
            <p>
              Proposed renewal due:{' '}
              <strong>{subscriptionUtcLabel(proposed)}</strong>.
            </p>
            <p>
              Remaining Credits may be used until{' '}
              <strong>{subscriptionUtcLabel(cutoff)}</strong>. At that instant,
              new runtime stops; overdue Partners also lose assigned client
              access. Login and billing remain available.
            </p>
            {Date.parse(cutoff) <= Date.parse(state.serverTime) && (
              <p className="font-medium">
                This cutoff has already passed. Saving stops new runtime
                immediately.
              </p>
            )}
          </div>
        )}
        <p className="max-w-3xl text-sm leading-6 text-gray-11">
          No Credits are added, reset or rolled over. Existing holds, exhausted
          Credits and other plan limits still apply. This does not record a
          payment, change the subscription price, or change course, assessment
          or certificate records.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={
              busy || !state.canManage || !proposed || !cutoff || !validReason
            }
          >
            {busy ? 'Saving…' : 'Save renewal date'}
          </Button>
          {canReset && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !validReason}
              onClick={() => void save(true)}
            >
              Reset date override
            </Button>
          )}
        </div>
        {canReset && (
          <p className="text-sm text-gray-11">
            Resetting removes this manual override. Funded paid plans return to
            their normal renewal date and 15-day remaining-Credits grace. Core
            training returns to its original fixed window. This does not renew
            expired access or refill Credits.
          </p>
        )}
        {!!notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
      </form>
    </section>
  );
}
