import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';

import { ClientAiAllowanceSection } from './ai-allowance-section';
import {
  AiSettings,
  AiSettingsError,
  approveAiPricing,
  ManagedModel,
  observeAiPricing,
  saveAiSettings,
  useAiSettings,
} from './ai-settings-api';
import { managedAiNextStep } from './managed-ai-entry';
import { operatorClientsQuery, useHostedOperatorAccess } from './operator-api';

type Access = ReturnType<typeof useHostedOperatorAccess>;
const names: Record<ManagedModel, string> = {
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
};
const modelName = (model: ManagedModel | null) =>
  model ? names[model] : 'No model selected';
const selectStyle =
  'mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9';
function date(value: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        timeZone: 'UTC',
        timeZoneName: 'short',
      })
    : 'Not recorded';
}
function message(error: unknown) {
  return error instanceof AiSettingsError && error.kind === 'conflict'
    ? 'These settings changed while you were editing. Refresh, review the current values and try again.'
    : 'This change could not be completed. Refresh to check your access and the saved settings before retrying.';
}

export function ManagedAiSettingsPage() {
  const access = useHostedOperatorAccess();
  return <SessionSettings key={access.session.epoch} access={access} />;
}
function SessionSettings({ access }: { access: Access }) {
  const [target, setTarget] = useState('');
  const [targetName, setTargetName] = useState('Global default');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const after = cursors[cursors.length - 1];
  const clients = useQuery(
    operatorClientsQuery(access.session, after, access.allowed),
  );
  const settings = useAiSettings(
    access.session,
    access.allowed,
    target || undefined,
  );
  const global = useAiSettings(access.session, access.allowed);
  const scopeAvailable =
    !target ||
    clients.data?.clients.some((client) => client.platformId === target);
  function page(next: boolean) {
    setTarget('');
    setTargetName('Global default');
    setCursors((values) =>
      next ? [...values, clients.data?.next ?? null] : values.slice(0, -1),
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">Managed AI settings</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
          Configure the operator-funded service shown to customers as Sydekyks.
          Global defaults apply unless a client has an explicit override. Client
          BYOK remains a separate connection and payer.
        </p>
      </header>
      {!access.hosted || access.session.kind !== 'user' ? (
        <p role="status">
          Sign in to your hosted Sydekyks operator account to manage AI
          settings.
        </p>
      ) : access.isPending ? (
        <p role="status">Checking operator access…</p>
      ) : !access.allowed ? (
        <p role="alert">
          Only configured Sydekyks operators can access these settings. Client
          administrators and partners do not have access.
        </p>
      ) : (
        <>
          <section aria-labelledby="settings-scope" className="max-w-3xl">
            <h2 id="settings-scope" className="text-lg font-semibold">
              Choose the settings scope
            </h2>
            <label
              htmlFor="ai-settings-scope"
              className="mt-4 block text-sm font-medium"
            >
              Global default or client workspace
            </label>
            <select
              id="ai-settings-scope"
              className={selectStyle}
              value={target}
              disabled={clients.isFetching}
              onChange={(event) => {
                setTarget(event.target.value);
                setTargetName(event.target.selectedOptions[0].text);
              }}
            >
              <option value="">Global default — all inheriting clients</option>
              {clients.data?.clients.map((client) => (
                <option key={client.platformId} value={client.platformId}>
                  {client.name}
                </option>
              ))}
            </select>
            {clients.isError && (
              <p role="alert" className="mt-3 text-sm">
                Client names could not load. Refresh the list to retry.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={cursors.length === 1 || clients.isFetching}
                onClick={() => page(false)}
              >
                Previous clients
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!clients.data?.next || clients.isFetching}
                onClick={() => page(true)}
              >
                More clients
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={clients.isFetching}
                onClick={() => void clients.refetch()}
              >
                Refresh client list
              </Button>
            </div>
          </section>
          {!scopeAvailable ? (
            <p role="alert">
              Choose a client from the current authorized list.
            </p>
          ) : (
            <>
              {settings.isPending || global.isPending ? (
                <p role="status">Loading managed AI settings…</p>
              ) : settings.isError || global.isError ? (
                <div role="alert">
                  <p>
                    Managed AI settings could not load. Refresh to check access
                    and availability.
                  </p>
                  <Button
                    className="mt-3"
                    variant="outline"
                    onClick={() => {
                      void settings.refetch();
                      void global.refetch();
                    }}
                  >
                    Refresh settings
                  </Button>
                </div>
              ) : (
                <SettingsEditor
                  key={`${target}:${settings.data.revision}:${settings.data.globalRevision}`}
                  access={access}
                  state={settings.data}
                  globalState={global.data}
                  targetName={targetName}
                  refresh={() => {
                    void settings.refetch();
                    void global.refetch();
                  }}
                />
              )}
              <ClientAiAllowanceSection
                access={access}
                platformId={target}
                clientName={targetName}
              />
              {global.data && !global.isError && (
                <PricingReview
                  key={`${global.data.pricing.revision}:${global.data.pricing.observationId}`}
                  access={access}
                  state={global.data}
                  refresh={() => void global.refetch()}
                />
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}

function SettingsEditor({
  access,
  state,
  globalState,
  targetName,
  refresh,
}: {
  access: Access;
  state: AiSettings;
  globalState: AiSettings;
  targetName: string;
  refresh: () => void;
}) {
  const cache = useQueryClient();
  const isClient = state.scopePlatformId !== null;
  const [mode, setMode] = useState(
    !isClient && state.mode === 'inherit' ? 'set' : state.mode,
  );
  const [model, setModel] = useState<'inherit' | ManagedModel>(
    state.model ?? (isClient ? 'inherit' : 'deepseek-flash'),
  );
  const [credentialAction, setCredentialAction] = useState<
    'keep' | 'replace' | 'inherit'
  >(
    isClient && state.credential.scope !== 'client'
      ? 'inherit'
      : state.credential.configured
      ? 'keep'
      : 'replace',
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const secret = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  const inheritedModel =
    isClient && (mode === 'inherit' || model === 'inherit');
  const effectiveModel = inheritedModel
    ? globalState.effective.model
    : model === 'inherit'
    ? null
    : model;
  const disabledFields = busy || mode !== 'set';
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus('');
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      const action =
        mode === 'disabled' && !isClient
          ? 'keep'
          : isClient && mode !== 'set'
          ? 'inherit'
          : credentialAction;
      const key =
        action === 'replace' ? secret.current?.value.trim() : undefined;
      if (
        action === 'replace' &&
        (!key || /\s/.test(key) || key.length < 16 || key.length > 512)
      ) {
        setStatus(
          'Enter a provider key between 16 and 512 characters, without spaces.',
        );
        return;
      }
      await saveAiSettings(
        access.session,
        {
          ...(state.scopePlatformId
            ? { platformId: state.scopePlatformId }
            : {}),
          expectedRevision: state.revision,
          expectedGlobalRevision: state.globalRevision,
          requestKey: crypto.randomUUID(),
          mode,
          model: isClient && mode !== 'set' ? 'inherit' : model,
          credentialAction: action,
          ...(key ? { apiKey: key } : {}),
        },
        attempt.signal,
      );
      assertAuthSession(access.session);
      if (!active.current || attempt.signal.aborted) return;
      setStatus(
        'Settings saved. The displayed effective settings have been refreshed.',
      );
      await cache.invalidateQueries({ queryKey: ['hosted-ai-settings'] });
    } catch (error) {
      if (active.current && !attempt.signal.aborted) {
        try {
          assertAuthSession(access.session);
          setStatus(message(error));
        } catch {
          /* The next account has a fresh form. */
        }
      }
    } finally {
      if (secret.current) secret.current.value = '';
      if (active.current) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="managed-configuration"
      className="border-y border-gray-6 py-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="managed-configuration" className="text-lg font-semibold">
            {isClient ? targetName : 'Global managed AI default'}
          </h2>
          <p className="mt-2 text-sm text-gray-11">
            Saved revision {state.revision} · Global revision{' '}
            {state.globalRevision}
          </p>
        </div>
        <Button variant="outline" disabled={busy} onClick={refresh}>
          Refresh settings
        </Button>
      </div>
      <dl className="my-5 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="font-medium">Saved effective model</dt>
        <dd>{modelName(state.effective.model)}</dd>
        <dt className="font-medium">Managed service</dt>
        <dd>
          {globalState.mode === 'disabled'
            ? 'Paused globally for all clients'
            : state.effective.managedAvailable
            ? 'Available with current approved pricing'
            : state.mode === 'disabled'
            ? 'Disabled for this scope'
            : 'Unavailable — check key configuration and pricing approval'}
        </dd>
        <dt className="font-medium">Saved credential</dt>
        <dd>
          {state.credential.configured
            ? `${
                state.credential.scope === 'global'
                  ? 'Global'
                  : 'Client-specific'
              } key configured · value hidden`
            : 'No effective key configured'}
        </dd>
      </dl>
      {!isClient && state.mode === 'set' && (
        <p className="mb-4 max-w-3xl text-sm leading-6">
          This saved configuration is already the global Sydekyks default.
          Clients inherit it unless they have an explicit override.
        </p>
      )}
      {!isClient && !state.effective.managedAvailable && (
        <p className="mb-4 max-w-3xl text-sm leading-6">
          {managedAiNextStep(state)}
        </p>
      )}
      {state.effective.reason && (
        <p className="mb-4 max-w-3xl text-sm leading-6 text-gray-11">
          {state.effective.reason}
        </p>
      )}
      <form className="max-w-3xl space-y-5" onSubmit={save} autoComplete="off">
        <div>
          <label className="block text-sm font-medium" htmlFor="managed-mode">
            Managed AI behavior
          </label>
          <select
            id="managed-mode"
            className={selectStyle}
            value={mode}
            disabled={busy}
            onChange={(event) => {
              setMode(event.target.value as typeof mode);
              if (secret.current) secret.current.value = '';
            }}
          >
            {isClient && (
              <option value="inherit">Inherit the global default</option>
            )}
            <option value="set">
              {isClient ? 'Use a client override' : 'Enable global default'}
            </option>
            <option value="disabled">
              {isClient
                ? 'Disable managed AI for this client'
                : 'Pause managed AI for all clients'}
            </option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="managed-model">
            Upstream model
          </label>
          <select
            id="managed-model"
            className={selectStyle}
            value={model}
            disabled={disabledFields}
            onChange={(event) => setModel(event.target.value as typeof model)}
          >
            {isClient && (
              <option value="inherit">
                Inherit global model — {modelName(globalState.effective.model)}
              </option>
            )}
            <option value="deepseek-flash">DeepSeek Flash</option>
            <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
          </select>
        </div>
        <div>
          <label
            className="block text-sm font-medium"
            htmlFor="managed-key-action"
          >
            Provider credential
          </label>
          <select
            id="managed-key-action"
            className={selectStyle}
            value={credentialAction}
            disabled={disabledFields}
            onChange={(event) => {
              setCredentialAction(
                event.target.value as typeof credentialAction,
              );
              if (secret.current) secret.current.value = '';
            }}
          >
            {isClient && <option value="inherit">Use the global key</option>}
            <option
              value="keep"
              disabled={
                !state.credential.configured ||
                (isClient && state.credential.scope !== 'client')
              }
            >
              Keep the configured key
            </option>
            <option value="replace">
              {isClient
                ? 'Set or replace the client override key'
                : 'Set or replace the global key'}
            </option>
          </select>
        </div>
        {credentialAction === 'replace' && mode === 'set' && (
          <div>
            <label
              className="block text-sm font-medium"
              htmlFor="managed-secret"
            >
              New provider API key
            </label>
            <Input
              id="managed-secret"
              ref={secret}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              minLength={16}
              maxLength={512}
              disabled={busy}
              className="mt-2"
              aria-describedby="managed-secret-help"
            />
            <p id="managed-secret-help" className="mt-2 text-sm text-gray-11">
              Write-only. The value is cleared after submission and is never
              returned by this panel.
            </p>
          </div>
        )}
        <p className="text-sm leading-6 text-gray-11">
          After saving:{' '}
          {mode === 'disabled'
            ? isClient
              ? 'managed AI is explicitly disabled for this client.'
              : 'managed AI is paused for all clients, including clients with overrides.'
            : `${modelName(effectiveModel)} ${
                inheritedModel
                  ? 'from the global default'
                  : 'selected for this scope'
              }.`}{' '}
          {isClient
            ? 'A managed override still uses the client’s normal monthly credits and operator spending caps. It does not change BYOK.'
            : 'Model and key changes affect inheriting clients. A global pause applies to every client; BYOK is unchanged.'}
        </p>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving settings…' : 'Save managed AI settings'}
        </Button>
        {status && (
          <p role="status" className="text-sm">
            {status}
          </p>
        )}
      </form>
    </section>
  );
}

function PricingReview({
  access,
  state,
  refresh,
}: {
  access: Access;
  state: AiSettings;
  refresh: () => void;
}) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState('');
  const [approvalUntil, setApprovalUntil] = useState(
    state.pricing.calendar.until.slice(0, 16),
  );
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  const pricing = state.pricing;
  useEffect(() => {
    setConfirmed(false);
  }, [
    pricing.observationId,
    pricing.termsHash,
    pricing.calendar.version,
    approvalUntil,
  ]);
  useEffect(() => {
    setApprovalUntil(pricing.calendar.until.slice(0, 16));
  }, [pricing.calendar.until]);
  const expiryTime = approvalUntil
    ? Date.parse(`${approvalUntil}:00.000Z`)
    : NaN;
  const expires = Number.isFinite(expiryTime)
    ? new Date(expiryTime).toISOString()
    : null;
  const canApprove =
    !busy &&
    confirmed &&
    expires !== null &&
    expiryTime > Date.now() &&
    expiryTime <= Date.parse(pricing.calendar.until) &&
    Date.parse(pricing.sourceValidUntil ?? '') > Date.now() &&
    !!pricing.terms &&
    !!pricing.observationId &&
    !!pricing.termsHash &&
    ['needs_approval', 'ready', 'expired', 'mismatch'].includes(pricing.status);
  async function action(approve: boolean) {
    if (busy || (approve && !canApprove)) return;
    setBusy(true);
    setStatus('');
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      if (approve && expires)
        await approveAiPricing(access.session, state, expires, attempt.signal);
      else if (approve) throw new AiSettingsError('unavailable');
      else await observeAiPricing(access.session, attempt.signal);
      assertAuthSession(access.session);
      if (!active.current || attempt.signal.aborted) return;
      setStatus(
        approve
          ? 'Published pricing and calendar approved.'
          : 'Pricing observation requested. Refresh to check the result.',
      );
      await cache.invalidateQueries({ queryKey: ['hosted-ai-settings'] });
    } catch (error) {
      if (active.current && !attempt.signal.aborted) {
        try {
          assertAuthSession(access.session);
          setStatus(message(error));
        } catch {
          /* Session changed. */
        }
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const money = (value: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 6,
    }).format(value / 1e6);
  return (
    <section aria-labelledby="managed-pricing">
      <h2 id="managed-pricing" className="text-lg font-semibold">
        Published pricing and approval
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
        The server observes the official price table. Review both models and the
        published UTC schedule before approval. An unapproved change or expired
        source blocks managed calls.
      </p>
      <dl className="my-5 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="font-medium">Refresh status</dt>
        <dd>{pricing.status.replaceAll('_', ' ')}</dd>
        <dt className="font-medium">Last observation</dt>
        <dd>{date(pricing.observedAt)}</dd>
        <dt className="font-medium">Source confirmation valid until</dt>
        <dd>{date(pricing.sourceValidUntil)}</dd>
        <dt className="font-medium">Current approval expires</dt>
        <dd>{date(pricing.approval?.validUntil ?? null)}</dd>
        <dt className="font-medium">Published source</dt>
        <dd>
          <a
            href={pricing.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all text-accent-11 underline underline-offset-4"
          >
            Official DeepSeek pricing
          </a>
        </dd>
        <dt className="font-medium">Peak / off-peak schedule</dt>
        <dd className="max-w-2xl leading-6">{pricing.calendar.schedule}</dd>
        <dt className="font-medium">Calendar version</dt>
        <dd>{pricing.calendar.version}</dd>
        <dt className="font-medium">UTC calendar validity</dt>
        <dd>
          {date(pricing.calendar.from)} — {date(pricing.calendar.until)}
        </dd>
      </dl>
      {pricing.terms ? (
        <div
          className="overflow-x-auto rounded-md border border-gray-6"
          tabIndex={0}
          role="region"
          aria-label="Published model prices"
        >
          <table className="w-full min-w-[620px] text-left text-sm">
            <caption className="p-3 text-left text-gray-11">
              USD per million tokens · peak and off-peak windows use the
              approved UTC calendar
            </caption>
            <thead>
              <tr className="border-b border-gray-6">
                <th className="p-3">Model / window</th>
                <th className="p-3">Input cache hit</th>
                <th className="p-3">Input cache miss</th>
                <th className="p-3">Output</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(names) as ManagedModel[]).flatMap((model) =>
                (['peak', 'offPeak'] as const).map((window) => (
                  <tr
                    key={`${model}-${window}`}
                    className="border-b border-gray-6 last:border-0"
                  >
                    <th className="p-3 font-medium">
                      {names[model]} · {window === 'peak' ? 'Peak' : 'Off-peak'}
                    </th>
                    <td className="p-3 tabular-nums">
                      {money(pricing.terms!.models[model][window].cacheHit)}
                    </td>
                    <td className="p-3 tabular-nums">
                      {money(pricing.terms!.models[model][window].cacheMiss)}
                    </td>
                    <td className="p-3 tabular-nums">
                      {money(pricing.terms!.models[model][window].output)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm">
          No validated published price table is available yet. Request an
          observation before approving.
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={busy || pricing.status === 'checking'}
          onClick={() => void action(false)}
        >
          {pricing.status === 'checking'
            ? 'Checking official pricing…'
            : 'Observe official pricing'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={refresh}>
          Refresh pricing status
        </Button>
      </div>
      <div className="mt-5 max-w-sm">
        <label htmlFor="pricing-approval-until" className="text-sm font-medium">
          Approval valid until (UTC)
        </label>
        <Input
          id="pricing-approval-until"
          type="datetime-local"
          className="mt-2"
          value={approvalUntil}
          max={pricing.calendar.until.slice(0, 16)}
          disabled={busy}
          onChange={(event) => {
            setConfirmed(false);
            setApprovalUntil(event.target.value);
          }}
          aria-describedby="pricing-approval-help"
        />
        <p id="pricing-approval-help" className="mt-2 text-sm text-gray-11">
          Approval can last until the verified calendar ends. The server keeps
          checking published prices separately; stale or changed pricing pauses
          managed calls until it is confirmed or approved again.
        </p>
      </div>
      <label className="mt-5 flex max-w-3xl items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          disabled={busy || !pricing.terms}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>
          I reviewed this published price table and UTC calendar. Approve this
          observation until {date(expires)}.
        </span>
      </label>
      <Button
        className="mt-4"
        disabled={!canApprove}
        onClick={() => void action(true)}
      >
        Approve observed pricing
      </Button>
      {status && (
        <p role="status" className="mt-3 text-sm">
          {status}
        </p>
      )}
    </section>
  );
}
