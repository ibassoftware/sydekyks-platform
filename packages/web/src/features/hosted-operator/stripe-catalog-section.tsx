import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';

import { useHostedOperatorAccess } from './operator-api';
import {
  confirmStripeCatalog,
  previewStripeCatalog,
  StripeCatalogError,
  StripeCatalogPreview,
  useStripeCatalog,
} from './stripe-catalog-api';

type Access = ReturnType<typeof useHostedOperatorAccess>;
const errorCopy: Record<string, string> = {
  HOSTING_STRIPE_CATALOG_OPEN_COMMANDS:
    'An earlier payment or portal request has an unresolved outcome, or a checkout remains open in Stripe. Resolve it before creating a preview. A local timeout does not prove that it closed.',
  HOSTING_STRIPE_CATALOG_PENDING_WEBHOOKS:
    'Stripe events still need reconciliation. Process them before creating another preview.',
  HOSTING_STRIPE_CATALOG_RECONCILIATION_BUSY:
    'A Stripe reconciliation is in progress. Wait for it to finish, then refresh.',
  HOSTING_STRIPE_CATALOG_PREVIEW_STALE:
    'Billing changed after this preview. Refresh and review a new preview.',
  HOSTING_STRIPE_CATALOG_PREVIEW_EXPIRED:
    'This five-minute preview expired. Create a new preview before confirming.',
  HOSTING_STRIPE_CATALOG_PROVIDER_CHANGED:
    'The Stripe customer or subscription changed. Review a new preview before confirming.',
  HOSTING_STRIPE_PRICE_DENIED:
    'A configured Stripe price or the existing subscription does not match the approved catalog. Resolve the price mapping in Stripe; this flow cannot change subscription prices.',
  HOSTING_STRIPE_ACCOUNT_MISMATCH:
    'The configured Stripe account differs from this workspace’s saved account. Cross-account migration is blocked.',
  HOSTING_STRIPE_PORTAL_POLICY_DENIED:
    'The Stripe portal configuration does not meet the required billing safeguards. Correct it before trying again.',
  HOSTING_OPERATOR_REQUIRED:
    'Your current account cannot manage the Stripe catalog. Sign in again as a Sydekyks platform administrator.',
};
function explanation(error: unknown) {
  return error instanceof StripeCatalogError && errorCopy[error.code]
    ? errorCopy[error.code]
    : 'The catalog operation was not confirmed. Refresh to check the current billing state before trying again.';
}
export function StripeCatalogSection(props: {
  access: Access;
  scopePlatformId: string;
  clientName: string;
}) {
  return (
    <CatalogEditor
      key={`${props.access.session.epoch}:${props.scopePlatformId}`}
      {...props}
    />
  );
}
function CatalogEditor({
  access,
  scopePlatformId,
  clientName,
}: {
  access: Access;
  scopePlatformId: string;
  clientName: string;
}) {
  const state = useStripeCatalog(
    access.session,
    scopePlatformId,
    access.allowed,
  );
  const [preview, setPreview] = useState<StripeCatalogPreview | null>(null);
  const [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const mounted = useRef(true),
    lock = useRef(false),
    controller = useRef<AbortController | null>(null),
    requestKey = useRef('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  async function perform(confirm: boolean) {
    if (lock.current || (confirm && (!preview || reason.trim().length < 3)))
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      if (confirm && preview) {
        await confirmStripeCatalog(
          access.session,
          scopePlatformId,
          preview.previewId,
          requestKey.current,
          reason.trim(),
          attempt.signal,
        );
        assertAuthSession(access.session);
        if (!mounted.current || attempt.signal.aborted) return;
        setPreview(null);
        setReason('');
        setNotice(
          'Catalog migration recorded. Reviewed local session records were retired. Subscription prices, paid Credits and existing billing holds were preserved. Stripe reconciliation can now resume.',
        );
        await state.refetch();
      } else {
        const value = await previewStripeCatalog(
          access.session,
          scopePlatformId,
          attempt.signal,
        );
        assertAuthSession(access.session);
        if (!mounted.current || attempt.signal.aborted) return;
        requestKey.current = crypto.randomUUID();
        setPreview(value);
        setReason('');
      }
    } catch (cause) {
      if (mounted.current && !attempt.signal.aborted) {
        try {
          assertAuthSession(access.session);
          setError(explanation(cause));
        } catch {
          /* Replaced session owns another editor. */
        }
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="stripe-catalog-heading"
      className="border-y border-gray-6 py-6"
    >
      <h2 id="stripe-catalog-heading" className="text-lg font-semibold">
        Stripe catalog
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
        {clientName || 'Select a workspace'} · Review the saved billing catalog
        before adopting the current plans. This flow uses Stripe test mode.
      </p>
      {!scopePlatformId ? (
        <p className="mt-4 text-sm">
          Select a workspace above to check its Stripe catalog.
        </p>
      ) : state.isPending ? (
        <p role="status" className="mt-4 text-sm">
          Loading the Stripe catalog…
        </p>
      ) : state.isError ? (
        <>
          <p role="alert" className="mt-4 text-sm">
            {explanation(state.error)}
          </p>
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => void state.refetch()}
          >
            Refresh catalog
          </Button>
        </>
      ) : (
        <>
          {state.data.mode === 'manual' ? (
            <p className="mt-4 max-w-3xl text-sm leading-6">
              Manual billing is enabled. Keep recording verified pilot receipts.
              Catalog migration becomes available when the server has a Stripe
              test key, approved price IDs and a webhook signing secret
              configured.
            </p>
          ) : state.data.state === 'unbound' ? (
            <p className="mt-4 text-sm leading-6">
              This workspace has no saved Stripe binding. Its first Stripe
              billing action will use the configured catalog.
            </p>
          ) : state.data.state === 'current' ? (
            <p role="status" className="mt-4 text-sm">
              This workspace already uses the current catalog.
            </p>
          ) : (
            <>
              <p className="mt-4 max-w-3xl text-sm leading-6">
                The saved catalog differs from the server configuration. Preview
                checks the Stripe account, all plan prices, portal settings and
                existing subscription. No Stripe purchase or subscription change
                is made.
              </p>
              <Button
                className="mt-4"
                disabled={busy}
                onClick={() => void perform(false)}
              >
                {busy
                  ? 'Checking Stripe…'
                  : preview
                  ? 'Create fresh preview'
                  : 'Preview catalog migration'}
              </Button>
            </>
          )}
          {preview && (
            <div className="mt-6 space-y-4">
              <h3 className="font-semibold">Review the verified catalog</h3>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-gray-11">Stripe test account</dt>
                  <dd className="break-all">{preview.accountId}</dd>
                </div>
                <div>
                  <dt className="text-gray-11">Subscription</dt>
                  <dd className="break-all">
                    {preview.subscriptionId
                      ? `${preview.subscriptionId} · ${preview.subscriptionStatus}`
                      : 'No subscription'}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-11">Saved catalog</dt>
                  <dd className="break-all">{preview.currentHash}</dd>
                </div>
                <div>
                  <dt className="text-gray-11">Proposed catalog</dt>
                  <dd className="break-all">{preview.targetHash}</dd>
                </div>
              </dl>
              <ul className="space-y-1 text-sm">
                {Object.entries(preview.plans).map(([plan, price]) => (
                  <li key={plan} className="break-words">
                    {plan === 'team'
                      ? 'Growth'
                      : plan === 'starter'
                      ? 'Starter'
                      : 'Scale'}
                    :{' '}
                    {(price.amountMinor / 100).toLocaleString(undefined, {
                      style: 'currency',
                      currency: 'USD',
                    })}
                    /month · {price.priceId}
                  </li>
                ))}
              </ul>
              {preview.retiringCommands.length > 0 && (
                <div className="space-y-2 text-sm">
                  <h4 className="font-medium">
                    Session records to retire locally
                  </h4>
                  <ul className="space-y-1">
                    {preview.retiringCommands.map((command) => (
                      <li key={command.commandId} className="break-all">
                        {command.commandId}:{' '}
                        {command.reason === 'portal_delivery_retired'
                          ? 'Stop delivering the old portal link. Existing Stripe access and cancellation rights remain unchanged.'
                          : command.reason === 'never_sent'
                          ? 'This request was never sent.'
                          : command.reason === 'checkout_expired'
                          ? 'Stripe confirmed checkout expired.'
                          : 'Stripe confirmed checkout completed.'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.retiringExpiredLease && (
                <p className="text-sm leading-6">
                  An expired reconciliation lease will be retired. Any late
                  response from that worker will be rejected.
                </p>
              )}
              {preview.pendingEvents > 0 && (
                <p className="text-sm leading-6">
                  {preview.pendingEvents} pending Stripe event(s) will be
                  retained for reconciliation. Existing billing holds remain in
                  place.
                </p>
              )}
              <p className="text-sm leading-6">
                The saved catalog reference and reviewed local session records
                change. Existing subscription prices, funded periods, Credits
                and billing holds stay in place. Preview expires at{' '}
                {new Date(preview.expiresAt).toLocaleTimeString()}.
              </p>
              <label
                className="block text-sm font-medium"
                htmlFor="stripe-catalog-reason"
              >
                Reason for this migration
              </label>
              <Textarea
                id="stripe-catalog-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                minLength={3}
                maxLength={500}
                disabled={busy}
                className="max-w-2xl text-base"
              />
              <Button
                disabled={busy || reason.trim().length < 3}
                onClick={() => void perform(true)}
              >
                {busy ? 'Confirming migration…' : 'Confirm catalog migration'}
              </Button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-4 max-w-3xl text-sm leading-6">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 max-w-3xl text-sm leading-6">
          {notice}
        </p>
      )}
    </section>
  );
}
