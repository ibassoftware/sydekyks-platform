import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatHostedCredits } from '@/features/hosted-chat/hosted-chat-api';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';

import {
  AiAllowance,
  aiAllowanceKey,
  saveAiAllowance,
  useAiAllowance,
} from './ai-allowance-api';
import { AiSettingsError } from './ai-settings-api';
import { useHostedOperatorAccess } from './operator-api';

type Access = ReturnType<typeof useHostedOperatorAccess>;
function dollars(credits: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 3,
  }).format(credits / 1000);
}
function utc(value: string) {
  return new Date(value).toLocaleString(undefined, {
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}
export function ClientAiAllowanceSection({
  access,
  platformId,
  clientName,
}: {
  access: Access;
  platformId: string;
  clientName: string;
}) {
  if (!platformId)
    return (
      <section aria-labelledby="client-allowance-heading">
        <h2 id="client-allowance-heading" className="text-lg font-semibold">
          Monthly AI allowance
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
          Pilot training includes 5,000 AI credits ($5) per 30-day period.
          Select a client workspace above to adjust its allowance.
        </p>
      </section>
    );
  return (
    <ClientAllowance
      key={`${access.session.epoch}:${platformId}`}
      access={access}
      platformId={platformId}
      clientName={clientName}
    />
  );
}
function ClientAllowance({
  access,
  platformId,
  clientName,
}: {
  access: Access;
  platformId: string;
  clientName: string;
}) {
  const cache = useQueryClient();
  const query = useAiAllowance(access.session, platformId, access.allowed);
  const [notice, setNotice] = useState('');
  async function saved(value: AiAllowance) {
    assertAuthSession(access.session);
    cache.setQueryData(aiAllowanceKey(access.session, platformId), value);
    setNotice(
      value.overrideMonthlyCredits === null
        ? 'Plan default restored. Usage, held costs and access dates are unchanged.'
        : 'Client allowance saved. Usage, held costs and access dates are unchanged.',
    );
    await refreshReferences();
  }
  async function refreshReferences() {
    assertAuthSession(access.session);
    await Promise.all(
      [
        'hosted-ai-allowance',
        'hosted-operator-clients',
        'hosted-billing',
        'hosted-chat-options',
      ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
    );
  }
  return (
    <section
      aria-labelledby="client-allowance-heading"
      className="border-y border-gray-6 py-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="client-allowance-heading" className="text-lg font-semibold">
            {query.data?.planId === 'assessment'
              ? 'Assessment AI budget'
              : 'Monthly AI allowance'}
          </h2>
          <p className="mt-2 text-sm text-gray-11">
            {clientName} · Managed Sydekyks credits
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            setNotice('');
            void query.refetch();
          }}
        >
          Refresh allowance
        </Button>
      </div>
      {notice && (
        <p role="status" className="mt-4 text-sm">
          {notice}
        </p>
      )}
      {query.isPending ? (
        <p role="status" className="mt-4 text-sm">
          Loading the client allowance…
        </p>
      ) : query.isError ? (
        <p role="alert" className="mt-4 text-sm">
          The allowance could not load. Refresh to check your access and the
          current limit.
        </p>
      ) : query.data.planId === 'assessment' ? (
        <p role="status" className="mt-4 max-w-3xl text-sm leading-6">
          Assessment access has a fixed one-time $1 managed AI budget. It cannot
          be increased through the monthly allowance setting and ends at the
          saved assessment deadline. Existing usage and held costs remain
          attached to this allowance.
        </p>
      ) : (
        <AllowanceEditor
          key={query.data.revision}
          state={query.data}
          access={access}
          onSaved={saved}
          onConflict={async () => {
            assertAuthSession(access.session);
            setNotice(
              'The allowance changed while you were editing. Review the refreshed limit before saving again.',
            );
            await refreshReferences();
          }}
        />
      )}
    </section>
  );
}
function AllowanceEditor({
  state,
  access,
  onSaved,
  onConflict,
}: {
  state: AiAllowance;
  access: Access;
  onSaved: (value: AiAllowance) => Promise<void>;
  onConflict: () => Promise<void>;
}) {
  const [basis, setBasis] = useState<'plan' | 'override'>(
    state.overrideMonthlyCredits === null ? 'plan' : 'override',
  );
  const [amount, setAmount] = useState(
    String(state.overrideMonthlyCredits ?? state.defaultMonthlyCredits),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true),
    lock = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const parsed = Number(amount);
  const valid =
    basis === 'plan' ||
    (amount.trim() !== '' &&
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 1_000_000);
  const selected = basis === 'plan' ? state.defaultMonthlyCredits : parsed;
  const usedAndHeld = state.period
    ? BigInt(state.period.consumedMicroUsd) +
      BigInt(state.period.reservedMicroUsd)
    : 0n;
  const stopsCurrentRequests =
    valid &&
    state.appliesToCurrentPeriod &&
    state.period &&
    BigInt(selected) * 1000n <= usedAndHeld;
  const trial = state.planId === 'trial';
  async function save(restore = false) {
    if (lock.current || (!restore && !valid)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      const result = await saveAiAllowance(
        access.session,
        state.scopePlatformId,
        state.revision,
        restore || basis === 'plan' ? null : selected,
        reason.trim() || undefined,
        attempt.signal,
      );
      assertAuthSession(access.session);
      if (!mounted.current || attempt.signal.aborted) return;
      await onSaved(result);
    } catch (cause) {
      if (mounted.current && !attempt.signal.aborted) {
        try {
          assertAuthSession(access.session);
          setError(
            cause instanceof AiSettingsError && cause.kind === 'conflict'
              ? 'This allowance changed while you were editing. Refresh, review the current limit and try again.'
              : 'The allowance was not confirmed. Refresh to check access and the saved limit before retrying.',
          );
          if (cause instanceof AiSettingsError && cause.kind === 'conflict')
            await onConflict();
        } catch {
          /* A changed account has a new editor. */
        }
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="mt-5 max-w-3xl space-y-5">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="font-medium">Saved monthly setting</dt>
        <dd>
          {state.effectiveMonthlyCredits.toLocaleString()} credits ·{' '}
          {dollars(state.effectiveMonthlyCredits)}
          {state.overrideMonthlyCredits === null
            ? ' · plan default'
            : ' · client override'}
        </dd>
        <dt className="font-medium">Plan default</dt>
        <dd>
          {state.defaultMonthlyCredits.toLocaleString()} credits ·{' '}
          {dollars(state.defaultMonthlyCredits)}
        </dd>
        <dt className="font-medium">Revision</dt>
        <dd>{state.revision}</dd>
      </dl>
      {trial && (
        <p className="text-sm leading-6 text-gray-11">
          The current trial is a one-off 14-day allowance and does not renew
          monthly. This monthly setting starts with training or paid periods; it
          does not top up or change the current trial.
        </p>
      )}
      {state.period ? (
        <div>
          <h3 className="mb-3 font-medium">
            {trial ? 'Trial allowance (one-off)' : 'Current period'}
          </h3>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="font-medium">Period allowance</dt>
            <dd>
              {formatHostedCredits(state.period.amountMicroUsd, '1000')} credits
            </dd>
            <dt className="font-medium">Used</dt>
            <dd>
              {formatHostedCredits(state.period.consumedMicroUsd, '1000')}{' '}
              credits
            </dd>
            <dt className="font-medium">Held for outstanding requests</dt>
            <dd>
              {formatHostedCredits(state.period.reservedMicroUsd, '1000')}{' '}
              credits
            </dd>
            <dt className="font-medium">Available now</dt>
            <dd>
              {formatHostedCredits(state.period.availableMicroUsd, '1000')}{' '}
              credits
            </dd>
            <dt className="font-medium">Period starts (UTC)</dt>
            <dd>{utc(state.period.validFrom)}</dd>
            <dt className="font-medium">Period ends (UTC)</dt>
            <dd>{utc(state.period.validUntil)}</dd>
          </dl>
        </div>
      ) : (
        <p className="text-sm text-gray-11">
          There is no current allowance period. Saving this setting does not
          create access, renew an expired account or add a new period.
        </p>
      )}
      {!trial && !state.appliesToCurrentPeriod && state.period && (
        <p className="text-sm leading-6 text-gray-11">
          This period is not eligible for a limit change. The setting is saved
          for future eligible periods without extending access.
        </p>
      )}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div>
          <label
            htmlFor="client-allowance-basis"
            className="block text-sm font-medium"
          >
            Allowance source
          </label>
          <select
            id="client-allowance-basis"
            value={basis}
            disabled={busy}
            onChange={(event) => setBasis(event.target.value as typeof basis)}
            className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9"
          >
            <option value="plan">
              Use the plan default —{' '}
              {state.defaultMonthlyCredits.toLocaleString()} credits
            </option>
            <option value="override">Set a client allowance</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="client-monthly-ai-credits"
            className="block text-sm font-medium"
          >
            AI credits per monthly plan period
          </label>
          <Input
            id="client-monthly-ai-credits"
            className="mt-2"
            type="number"
            inputMode="numeric"
            step={1}
            min={0}
            max={1000000}
            value={
              basis === 'plan' ? String(state.defaultMonthlyCredits) : amount
            }
            disabled={busy || basis === 'plan'}
            onChange={(event) => setAmount(event.target.value)}
            aria-describedby="client-allowance-preview client-allowance-help"
            aria-invalid={!valid}
          />
          <p id="client-allowance-preview" className="mt-2 text-sm font-medium">
            {valid
              ? `${selected.toLocaleString()} credits · Up to ${dollars(
                  selected,
                )} in managed AI usage per month at full use.`
              : 'Enter a whole number from 0 to 1,000,000.'}
          </p>
          <p
            id="client-allowance-help"
            className="mt-2 text-sm leading-6 text-gray-11"
          >
            Zero credits stops new managed AI usage when this monthly limit
            applies. BYOK, provider settings and execution limits are unchanged.
          </p>
        </div>
        {stopsCurrentRequests && (
          <p role="status" className="text-sm leading-6 text-gray-11">
            This limit leaves no credits for new managed requests in the current
            period. Existing usage and held costs remain counted; nothing is
            reset or refunded.
          </p>
        )}
        <div>
          <label
            htmlFor="client-allowance-reason"
            className="block text-sm font-medium"
          >
            Reason (optional)
          </label>
          <Textarea
            id="client-allowance-reason"
            className="mt-2"
            rows={2}
            maxLength={500}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-2 text-sm text-gray-11">
            A short note for your operations record.
          </p>
        </div>
        <p className="text-sm leading-6 text-gray-11">
          Changing this allowance does not automatically change the subscription
          price. Credits set a dollar budget; actual token usage depends on the
          model. Changes apply to current eligible and future plan periods.
          Usage and held costs are preserved. Credits do not roll over, and
          saving does not change period dates or renew access.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || !valid}>
            {busy ? 'Saving allowance…' : 'Save client allowance'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || state.overrideMonthlyCredits === null}
            onClick={() => void save(true)}
          >
            Restore plan default
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
