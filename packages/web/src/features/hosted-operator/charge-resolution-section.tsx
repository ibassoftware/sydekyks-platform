import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';

import {
  ChargeDraft,
  ChargePreview,
  ChargeResolutionError,
  ChargeView,
  chargeKey,
  previewCharge,
  resolveCharge,
  useChargeList,
  useChargeView,
} from './charge-resolution-api';
import { useHostedOperatorAccess } from './operator-api';

type Access = ReturnType<typeof useHostedOperatorAccess>;
const selectClass =
  'mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9';
const outcomes = {
  retain: 'Keep held — outcome is still unknown',
  verified_usage: 'Record supplier usage evidence',
  confirmed_not_sent: 'Confirm the request was not sent',
};
const blockerCopy: Record<string, string> = {
  UNRESOLVED_SIBLING_CALL: 'Another AI call in this execution is unresolved.',
  UNRESOLVED_SIBLING_RESERVATION:
    'Another reservation in this execution is still held.',
  ROOT_NOT_PENDING: 'The execution has already been closed.',
  LIVE_OR_UNCONFIRMED_SEGMENT:
    'An execution segment is still active or lacks a safe terminal result.',
};
const usd = (value: string) =>
  (Number(value) / 1_000_000).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  });
const utc = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        timeZone: 'UTC',
        timeZoneName: 'short',
      })
    : 'Not recorded';
function errorCopy(error: unknown) {
  if (error instanceof ChargeResolutionError) {
    if (error.code.includes('CONFLICT'))
      return 'This charge changed after your preview. Refresh and review its current state before creating another preview.';
    if (error.code.includes('UNSAFE'))
      return 'This call cannot be settled safely yet. Keep its hold and refresh after the running request has ended.';
    if (error.code.includes('OPERATOR') || error.code === 'SESSION')
      return 'Your current session cannot manage this charge. Sign in again as a Sydekyks administrator.';
    if (
      error.code.includes('INVALID') ||
      error.code.includes('USAGE') ||
      error.code.includes('TARIFF')
    )
      return 'The evidence does not match this call’s saved pricing or usage bounds. Check the supplier record before trying again.';
  }
  return 'The action was not confirmed. Refresh to inspect the charge and audit history before retrying. Retrying the same confirmation will not charge twice.';
}
export function ChargeResolutionSection({
  access,
  scopePlatformId,
  clientName,
}: {
  access: Access;
  scopePlatformId: string;
  clientName: string;
}) {
  const list = useChargeList(access.session, scopePlatformId, access.allowed);
  const [callId, setCallId] = useState('');
  const [lookupId, setLookupId] = useState('');
  return (
    <section aria-labelledby="charge-resolution-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="charge-resolution-heading" className="text-lg font-semibold">
            Held AI charges
          </h2>
          <p className="mt-2 max-w-prose text-sm leading-6 text-gray-11">
            {clientName} · Holds protect Credits while a supplier outcome is
            uncertain. Resolve them using traceable evidence, or record a
            follow-up and keep the hold.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={list.isFetching}
          onClick={() => void list.refetch()}
        >
          Refresh charges
        </Button>
      </div>
      {list.isPending ? (
        <p role="status" className="mt-4 text-sm">
          Loading held charges…
        </p>
      ) : list.isError ? (
        <p role="alert" className="mt-4 text-sm">
          {errorCopy(list.error)}
        </p>
      ) : (
        <>
          {!list.data.calls.length ? (
            <p role="status" className="mt-4 text-sm">
              No pending AI charges in this workspace.
            </p>
          ) : (
            <>
              <label
                htmlFor="held-ai-call"
                className="mt-4 block text-sm font-medium"
              >
                AI call to review
              </label>
              <select
                id="held-ai-call"
                value={callId}
                onChange={(event) => setCallId(event.target.value)}
                className={selectClass}
              >
                <option value="">Select a held charge</option>
                {list.data.calls.map((call) => (
                  <option key={call.callId} value={call.callId}>
                    {call.callId} ·{' '}
                    {call.payer === 'byok'
                      ? 'BYOK'
                      : `${call.heldCredits} Credits`}{' '}
                    · {call.state}
                  </option>
                ))}
              </select>
            </>
          )}
          {list.data.hasMore && (
            <p className="mt-3 text-sm">
              Showing the oldest 100 pending calls. Resolve these first, then
              refresh for the next calls.
            </p>
          )}
        </>
      )}
      <div className="mt-5">
        <label htmlFor="charge-lookup" className="block text-sm font-medium">
          Find an AI call by ID, including resolved calls
        </label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <Input
            id="charge-lookup"
            className="text-base"
            maxLength={21}
            value={lookupId}
            onChange={(event) => setLookupId(event.target.value.trim())}
          />
          <Button
            variant="outline"
            disabled={!/^[A-Za-z0-9_-]{21}$/.test(lookupId)}
            onClick={() => setCallId(lookupId)}
          >
            Open charge record
          </Button>
        </div>
      </div>
      {callId && (
        <ChargeDetail
          key={`${access.session.epoch}:${scopePlatformId}:${callId}`}
          access={access}
          platformId={scopePlatformId}
          callId={callId}
        />
      )}
    </section>
  );
}
function ChargeDetail({
  access,
  platformId,
  callId,
}: {
  access: Access;
  platformId: string;
  callId: string;
}) {
  const view = useChargeView(
    access.session,
    platformId,
    callId,
    access.allowed,
  );
  return (
    <div className="mt-6 border-t border-gray-6 pt-6">
      {view.isPending ? (
        <p role="status">Loading the charge record…</p>
      ) : view.isError ? (
        <>
          <p role="alert" className="text-sm">
            {errorCopy(view.error)}
          </p>
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => void view.refetch()}
          >
            Refresh charge record
          </Button>
        </>
      ) : (
        <ChargeEditor
          key={`${view.data.callId}:${view.data.revision}:${view.data.stateHash}`}
          access={access}
          view={view.data}
          refresh={() => view.refetch()}
        />
      )}
    </div>
  );
}
function ChargeEditor({
  access,
  view,
  refresh,
}: {
  access: Access;
  view: ChargeView;
  refresh: () => Promise<unknown>;
}) {
  const cache = useQueryClient();
  const [outcome, setOutcome] = useState<ChargeDraft['outcome']>('retain');
  const [reason, setReason] = useState(''),
    [evidence, setEvidence] = useState(''),
    [supplierId, setSupplierId] = useState('');
  const [supplierCreatedAt, setSupplierCreatedAt] = useState('');
  const [hit, setHit] = useState('0'),
    [miss, setMiss] = useState(''),
    [output, setOutput] = useState('');
  const [preview, setPreview] = useState<ChargePreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [confirmedEvidence, setConfirmedEvidence] = useState(false);
  const lock = useRef(false),
    mounted = useRef(true),
    controller = useRef<AbortController | null>(null),
    requestKey = useRef('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  function changed(fn: () => void) {
    fn();
    setPreview(null);
    setConfirmedEvidence(false);
    setError('');
  }
  const validToken = (value: string) =>
    /^\d{1,8}$/.test(value) && Number(value) <= 10_000_000;
  const valid =
    reason.trim().length >= 10 &&
    evidence.trim().length >= 10 &&
    (outcome !== 'verified_usage' ||
      (supplierId.trim().length > 0 &&
        Number.isFinite(Date.parse(supplierCreatedAt + 'Z')) &&
        [hit, miss, output].every(validToken))) &&
    (outcome === 'retain' || view.canResolve);
  function draft(): ChargeDraft {
    return {
      platformId: view.platformId,
      rootReservationId: view.rootReservationId,
      outcome,
      reason: reason.trim(),
      evidenceReference: evidence.trim(),
      ...(outcome === 'verified_usage'
        ? {
            supplierRequestId: supplierId.trim(),
            supplierCreatedAt: new Date(supplierCreatedAt + 'Z').toISOString(),
            usage: {
              prompt_cache_hit_tokens: Number(hit),
              prompt_cache_miss_tokens: Number(miss),
              completion_tokens: Number(output),
            },
          }
        : {}),
    };
  }
  async function perform(confirm: boolean) {
    if (lock.current || !valid || (confirm && (!preview || !confirmedEvidence)))
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      if (confirm && preview) {
        const result = await resolveCharge(
          access.session,
          view.callId,
          draft(),
          preview.preview,
          requestKey.current,
          attempt.signal,
        );
        assertAuthSession(access.session);
        if (!mounted.current || attempt.signal.aborted) return;
        cache.setQueryData(
          chargeKey(access.session, view.platformId, view.callId),
          result.view,
        );
        await Promise.all(
          [
            'hosted-charge-resolution',
            'hosted-billing',
            'hosted-operator-clients',
            'hosted-chat-options',
          ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
        );
      } else {
        const result = await previewCharge(
          access.session,
          view.callId,
          draft(),
          attempt.signal,
        );
        assertAuthSession(access.session);
        if (!mounted.current || attempt.signal.aborted) return;
        setPreview(result);
        setConfirmedEvidence(false);
        requestKey.current = crypto.randomUUID();
      }
    } catch (cause) {
      if (mounted.current && !attempt.signal.aborted) {
        try {
          assertAuthSession(access.session);
          setError(errorCopy(cause));
        } catch {
          /* Session replacement owns the next editor. */
        }
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Charge record · {view.state}</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh charge record
        </Button>
      </div>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <Fact name="AI call" value={view.callId} />
        <Fact name="Execution" value={view.rootReservationId} />
        <Fact name="Held Credits" value={view.heldCredits} />
        <Fact
          name="Supplier liability"
          value={
            view.payer === 'byok'
              ? 'Client pays supplier directly (BYOK)'
              : usd(view.heldSupplierMicroUsd)
          }
        />
        <Fact
          name="Saved conversion"
          value={
            view.payer === 'byok'
              ? 'No managed AI charge'
              : `1 Credit per ${usd(view.microUsdPerCredit)}`
          }
        />
        <Fact
          name="Original budget day"
          value={view.budgetDay ?? 'Not recorded'}
        />
        {view.model && <Fact name="Supplier model" value={view.model} />}
        {view.requestHash && (
          <Fact name="Request fingerprint" value={view.requestHash} />
        )}
        <Fact name="Sent at" value={utc(view.sentAt)} />
        <Fact name="Request lease ends" value={utc(view.leaseUntil)} />
      </dl>
      {view.history.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Recorded decisions</h4>
          <ol className="mt-3 space-y-4">
            {view.history.map((item) => (
              <li key={item.id} className="break-words text-sm leading-6">
                <p>
                  {utc(item.created)} · {outcomes[item.outcome]}
                </p>
                <p>{item.reason}</p>
                <p className="text-gray-11">
                  Evidence: {item.evidenceReference}
                </p>
                <p className="text-gray-11">Audit: {item.id}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
      {['settled', 'cancelled'].includes(view.state) ? (
        <p role="status" className="text-sm">
          Resolution recorded. This AI call has no remaining hold. Its audit
          history remains available above.
        </p>
      ) : (
        <>
          {!view.canResolve && (
            <p role="status" className="text-sm leading-6">
              This call is still active or cannot be safely settled yet. You can
              record a follow-up while keeping its hold.
            </p>
          )}
          <div>
            <label
              htmlFor="charge-outcome"
              className="block text-sm font-medium"
            >
              Decision
            </label>
            <select
              id="charge-outcome"
              className={selectClass}
              value={outcome}
              disabled={busy}
              onChange={(event) =>
                changed(() =>
                  setOutcome(event.target.value as ChargeDraft['outcome']),
                )
              }
            >
              {Object.entries(outcomes).map(([key, label]) => (
                <option
                  key={key}
                  value={key}
                  disabled={key !== 'retain' && !view.canResolve}
                >
                  {label}
                </option>
              ))}
            </select>
          </div>
          <p className="max-w-prose text-sm leading-6 text-gray-11">
            Match the supplier’s record to this request, model and time. Your
            entry is an audited admin attestation; Sydekyks does not
            automatically verify the evidence. Do not paste API keys or customer
            prompts.
          </p>
          <div>
            <label
              htmlFor="charge-evidence"
              className="block text-sm font-medium"
            >
              Evidence reference or follow-up record
            </label>
            <Input
              id="charge-evidence"
              className="mt-2 text-base"
              value={evidence}
              minLength={10}
              maxLength={1000}
              disabled={busy}
              onChange={(event) =>
                changed(() => setEvidence(event.target.value))
              }
            />
          </div>
          {outcome === 'verified_usage' && (
            <>
              <div>
                <label
                  htmlFor="charge-supplier-id"
                  className="block text-sm font-medium"
                >
                  Supplier request ID
                </label>
                <Input
                  id="charge-supplier-id"
                  className="mt-2 text-base"
                  value={supplierId}
                  maxLength={200}
                  disabled={busy}
                  onChange={(event) =>
                    changed(() => setSupplierId(event.target.value))
                  }
                />
              </div>
              <div>
                <label
                  htmlFor="charge-supplier-time"
                  className="block text-sm font-medium"
                >
                  Supplier completion time (UTC)
                </label>
                <Input
                  id="charge-supplier-time"
                  type="datetime-local"
                  step="1"
                  className="mt-2 text-base"
                  value={supplierCreatedAt}
                  disabled={busy}
                  onChange={(event) =>
                    changed(() => setSupplierCreatedAt(event.target.value))
                  }
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  {
                    id: 'hit',
                    label: 'Cached input tokens',
                    value: hit,
                    set: setHit,
                  },
                  {
                    id: 'miss',
                    label: 'Uncached input tokens',
                    value: miss,
                    set: setMiss,
                  },
                  {
                    id: 'output',
                    label: 'Output tokens',
                    value: output,
                    set: setOutput,
                  },
                ].map((item) => (
                  <div key={item.id}>
                    <label
                      htmlFor={`charge-${item.id}`}
                      className="block text-sm font-medium"
                    >
                      {item.label}
                    </label>
                    <Input
                      id={`charge-${item.id}`}
                      className="mt-2 text-base"
                      inputMode="numeric"
                      value={item.value}
                      disabled={busy}
                      onChange={(event) =>
                        changed(() => item.set(event.target.value))
                      }
                    />
                  </div>
                ))}
              </div>
            </>
          )}
          <div>
            <label
              htmlFor="charge-reason"
              className="block text-sm font-medium"
            >
              Reason for the decision
            </label>
            <Textarea
              id="charge-reason"
              className="mt-2 text-base"
              value={reason}
              minLength={10}
              maxLength={1000}
              disabled={busy}
              onChange={(event) => changed(() => setReason(event.target.value))}
            />
          </div>
          <Button disabled={busy || !valid} onClick={() => void perform(false)}>
            {busy ? 'Checking charge…' : 'Preview decision'}
          </Button>
          {preview && (
            <div className="space-y-4 border-t border-gray-6 pt-5">
              <h4 className="font-semibold">Review the Credit change</h4>
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <Fact
                  name="AI Credits to charge"
                  value={
                    outcome === 'retain'
                      ? 'No change'
                      : preview.preview.actualCredits ?? '0 (BYOK)'
                  }
                />
                <Fact
                  name="Credits released from hold"
                  value={preview.preview.releasedCredits}
                />
                <Fact
                  name="Supplier cost recorded"
                  value={
                    preview.preview.actualMicroUsd === null
                      ? 'No managed cost change'
                      : usd(preview.preview.actualMicroUsd)
                  }
                />
                <Fact
                  name="Execution capacity"
                  value={
                    preview.preview.rootWillSettle
                      ? 'Close failed execution and free its slot'
                      : 'Keep current execution state'
                  }
                />
              </dl>
              {preview.preview.blockers.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {preview.preview.blockers.map((value) => (
                    <li key={value}>
                      {blockerCopy[value] ??
                        'This execution needs further review before its capacity can be released.'}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-sm leading-6">
                The original conversion rate applies. This decision does not
                rerun the request or refund the execution Credit. Keeping a hold
                leaves both Credits and supplier liability reserved.
              </p>
              <label className="flex items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-accent-9"
                  checked={confirmedEvidence}
                  disabled={busy}
                  onChange={(event) =>
                    setConfirmedEvidence(event.target.checked)
                  }
                />
                {outcome === 'retain'
                  ? 'Record this follow-up and keep the hold.'
                  : 'I matched the evidence to this request and accept responsibility for this recorded decision.'}
              </label>
              <Button
                disabled={busy || !confirmedEvidence}
                onClick={() => void perform(true)}
              >
                {busy
                  ? 'Recording decision…'
                  : outcome === 'retain'
                  ? 'Record follow-up'
                  : 'Confirm charge resolution'}
              </Button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm leading-6">
          {error}
        </p>
      )}
    </div>
  );
}
function Fact({ name, value }: { name: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-gray-11">{name}</dt>
      <dd className="mt-1 break-all tabular-nums">{value}</dd>
    </div>
  );
}
