import { hostingCatalog } from '@activepieces/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { AiSettingsError } from './ai-settings-api';
import {
  CreditAllowance,
  creditAllowanceKey,
  saveCreditAllowance,
  useCreditAllowance,
} from './credit-allowance-api';
import { useHostedOperatorAccess } from './operator-api';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatHostedCredits } from '@/features/hosted-chat/hosted-chat-api';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';
import {
  creditUnitsInput,
  formatCreditUnits,
  parseCreditInput,
} from '@/lib/hosted-credit-units';

type Access = ReturnType<typeof useHostedOperatorAccess>;
function utc(value: string) {
  return new Date(value).toLocaleString(undefined, {
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}
export function ClientCreditAllowanceSection({
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
          Monthly Credits allowance
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
          Select a funded Partner or client workspace above to adjust its shared
          monthly Credits.
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
  const query = useCreditAllowance(access.session, platformId, access.allowed);
  const [notice, setNotice] = useState('');
  async function saved(value: CreditAllowance) {
    assertAuthSession(access.session);
    cache.setQueryData(creditAllowanceKey(access.session, platformId), value);
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
        'hosted-credit-allowance',
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
            {query.data?.fixed
              ? 'Credits allowance'
              : 'Monthly Credits allowance'}
          </h2>
          <p className="mt-2 text-sm text-gray-11">
            {clientName} · Shared Credits for execution and Sydekyks AI
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
      ) : query.data.fixed ? (
        <p role="status" className="mt-4 max-w-3xl text-sm leading-6">
          Trial and assessment allowances are fixed. Monthly overrides apply
          only to funded Partner hosting and client subscriptions. Usage and
          held Credits remain attached to their original periods.
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
  state: CreditAllowance;
  access: Access;
  onSaved: (value: CreditAllowance) => Promise<void>;
  onConflict: () => Promise<void>;
}) {
  const [basis, setBasis] = useState<'plan' | 'override'>(
    state.overrideMonthlyCredits === null ? 'plan' : 'override',
  );
  const [amount, setAmount] = useState(
    creditUnitsInput(
      state.overrideMonthlyCredits ?? state.defaultMonthlyCredits,
    ),
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
  const parsed = parseCreditInput(amount);
  const valid =
    basis === 'plan' ||
    (amount.trim() !== '' &&
      parsed !== null &&
      (state.monthlyCreditCap == null || parsed <= state.monthlyCreditCap));
  const selected = basis === 'plan' ? state.defaultMonthlyCredits : parsed ?? 0;
  const usedAndHeld = state.period
    ? BigInt(state.period.consumed) + BigInt(state.period.reserved)
    : 0n;
  const stopsCurrentRequests =
    valid &&
    state.appliesToCurrentPeriod &&
    state.period !== null &&
    BigInt(selected) < usedAndHeld;
  const trial = state.fixed;
  async function save(restore = false) {
    if (
      lock.current ||
      (!restore && !valid) ||
      reason.trim().length < 3 ||
      (state.period &&
        BigInt(restore ? state.defaultMonthlyCredits : selected) < usedAndHeld)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      const result = await saveCreditAllowance(
        access.session,
        state.scopePlatformId,
        state.revision,
        restore || basis === 'plan' ? null : selected,
        reason.trim(),
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
          {formatCreditUnits(state.effectiveMonthlyCredits)} Credits
          {state.overrideMonthlyCredits === null
            ? ' · default allowance'
            : ' · client override'}
        </dd>
        <dt className="font-medium">Plan default</dt>
        <dd>{formatCreditUnits(state.defaultMonthlyCredits)} Credits</dd>
        <dt className="font-medium">Revision</dt>
        <dd>{state.revision}</dd>
      </dl>
      {state.monthlyCreditCap != null && (
        <p className="text-sm leading-6 text-gray-11">
          Partner Starter is capped at{' '}
          {formatCreditUnits(state.monthlyCreditCap)} Credits per month. No
          rollover or automatic overages.
        </p>
      )}
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
            <dd>{formatHostedCredits(state.period.amount, '1')} credits</dd>
            <dt className="font-medium">Used</dt>
            <dd>{formatHostedCredits(state.period.consumed, '1')} credits</dd>
            <dt className="font-medium">Held for outstanding requests</dt>
            <dd>{formatHostedCredits(state.period.reserved, '1')} credits</dd>
            <dt className="font-medium">Available now</dt>
            <dd>{formatHostedCredits(state.period.available, '1')} credits</dd>
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
              Use the default allowance —{' '}
              {formatCreditUnits(state.defaultMonthlyCredits)} credits
            </option>
            <option value="override">Set a client allowance</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="client-monthly-credits"
            className="block text-sm font-medium"
          >
            Credits per monthly plan period
          </label>
          <Input
            id="client-monthly-credits"
            className="mt-2"
            type="number"
            inputMode="decimal"
            step={0.01}
            min={0}
            max={
              state.monthlyCreditCap != null
                ? state.monthlyCreditCap / 100
                : 10000
            }
            value={
              basis === 'plan'
                ? creditUnitsInput(state.defaultMonthlyCredits)
                : amount
            }
            disabled={busy || basis === 'plan'}
            onChange={(event) => setAmount(event.target.value)}
            aria-describedby="client-allowance-preview client-allowance-help"
            aria-invalid={!valid}
          />
          <p id="client-allowance-preview" className="mt-2 text-sm font-medium">
            {valid
              ? `${formatCreditUnits(
                  selected,
                )} Credits per funded monthly period.`
              : 'Enter 0 to 10,000 Credits, in steps of 0.01.'}
          </p>
          {valid && (
            <p className="mt-2 text-sm leading-6 text-gray-11">
              At the current conversion, this allowance can fund up to{' '}
              {(
                (selected * hostingCatalog.aiMicroUsdPerCredit) /
                1_000_000
              ).toLocaleString(undefined, {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 4,
              })}{' '}
              of managed AI per month, before hosting and support. Changing the
              allowance does not increase the subscription price; price larger
              allowances separately. Older held calls retain their original
              conversion.
            </p>
          )}
          <p
            id="client-allowance-help"
            className="mt-2 text-sm leading-6 text-gray-11"
          >
            One shared balance funds workflow execution and Sydekyks AI. BYOK
            uses Credits for workflow runs; its supplier bills the client
            separately. An allowance cannot be reduced below used and held
            Credits.
          </p>
        </div>
        {stopsCurrentRequests && (
          <p role="status" className="text-sm leading-6 text-gray-11">
            This limit is below used and held Credits. Choose a higher amount or
            wait for outstanding requests to settle before reducing it.
          </p>
        )}
        <div>
          <label
            htmlFor="client-allowance-reason"
            className="block text-sm font-medium"
          >
            Reason (required)
          </label>
          <Textarea
            id="client-allowance-reason"
            className="mt-2"
            rows={2}
            maxLength={500}
            minLength={3}
            required
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-2 text-sm text-gray-11">
            A short note for your operations record.
          </p>
        </div>
        <p className="text-sm leading-6 text-gray-11">
          Changing Credits does not change the subscription price. Changes apply
          to eligible funded periods and future monthly grants. Used and held
          Credits are preserved. Credits do not roll over; saving never changes
          access dates, pays an invoice or renews an expired account.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            disabled={
              busy || !valid || reason.trim().length < 3 || stopsCurrentRequests
            }
          >
            {busy ? 'Saving allowance…' : 'Save client allowance'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              busy ||
              state.overrideMonthlyCredits === null ||
              reason.trim().length < 3 ||
              (state.period !== null &&
                BigInt(state.defaultMonthlyCredits) < usedAndHeld)
            }
            onClick={() => void save(true)}
          >
            Restore default allowance
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
