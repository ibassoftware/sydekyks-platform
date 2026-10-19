import {
  HostedBillingActionReason,
  HostedCustomerBillingOverview,
} from '@activepieces/shared';
import { t } from 'i18next';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { ReactNode } from 'react';

import { CenteredPage } from '@/components/custom/centered-page';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

type Props = {
  overview: HostedCustomerBillingOverview;
  stale: boolean;
  refreshing: boolean;
  pending: string | null;
  actionError: boolean;
  checkoutReturn: string | null;
  onRefresh: () => void;
  onCheckout: (id: 'starter' | 'team') => void;
  onPortal: () => void;
};
export function HostedBillingView({
  overview: info,
  stale,
  refreshing,
  pending,
  actionError,
  checkoutReturn,
  onRefresh,
  onCheckout,
  onPortal,
}: Props) {
  const manual = info.billingMode === 'manual';
  const blocked = stale || refreshing || pending !== null;
  return (
    <CenteredPage
      title={t('Billing & subscription')}
      description={t('Your hosted plan, allowances and payments.')}
      widthClassName="max-w-[56rem]"
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing || pending !== null}
          onClick={onRefresh}
          aria-label={t('Refresh billing')}
        >
          <RefreshCw className="mr-2 size-4" aria-hidden="true" />
          {refreshing ? t('Refreshing…') : t('Refresh')}
        </Button>
      }
    >
      <div className="space-y-6">
        <Alert role="status">
          <AlertDescription>
            {manual
              ? t(
                  'Payments are handled directly by Sydekyks. Contact the team to arrange a plan, renewal or invoice. Online checkout is unavailable.',
                )
              : t(
                  'Test billing. Stripe actions use test mode; no live payments are enabled.',
                )}
          </AlertDescription>
        </Alert>
        {stale && (
          <Notice>
            {t(
              'Refresh failed. These are the last loaded balances; payment actions are paused until a successful refresh.',
            )}
          </Notice>
        )}
        {actionError && (
          <Notice>
            {t(
              'The billing action could not be completed. Refresh to check its status before trying again.',
            )}
          </Notice>
        )}
        {!manual && checkoutReturn === 'success' && (
          <Notice>
            {t(
              'You returned from Checkout. Payment confirmation may still be pending. Your plan changes only after the server verifies payment.',
            )}
          </Notice>
        )}
        {!manual && checkoutReturn === 'cancel' && (
          <Notice>
            {t(
              'Checkout closed. No plan change is confirmed by this return link.',
            )}
          </Notice>
        )}
        {info.notice && (
          <Notice>
            {info.notice === 'account_paused'
              ? t(
                  'This account is paused. Contact support before purchasing a plan.',
                )
              : info.notice === 'billing_review'
              ? t(
                  'Billing needs review. New work may be paused while your payment status is checked.',
                )
              : t(
                  'Billing updates are delayed. Refresh later to check the verified status.',
                )}
          </Notice>
        )}
        <section aria-labelledby="hosted-current-plan" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="hosted-current-plan" className="text-base font-semibold">
              {planName(info.planId)}
            </h2>
            <span className="rounded-md border px-2 py-1 text-xs font-medium">
              {stateName(info.entitlementState)}
            </span>
          </div>
          <p className="text-sm text-gray-11">
            {info.planId === 'trial'
              ? t(
                  'Trial ends {date}. The trial has a time limit and limited allowances; there is no ongoing free hosted plan.',
                  { date: date(info.trialEndsAt) },
                )
              : info.planId === 'assessment'
              ? t(
                  'Assessment access ends {date}. This is a one-time allowance for your assessment, with no renewal or rollover.',
                  { date: date(info.validUntil) },
                )
              : info.planId === 'training'
              ? t(
                  'Training access ends {date}. Credits refresh every 30 days during included access, with no rollover.',
                  { date: date(info.validUntil) },
                )
              : t(
                  'Paid through {date}. Allowances shown below belong to the displayed period.',
                  { date: date(info.validUntil) },
                )}
          </p>
          {(info.entitlementState === 'expired' ||
            info.entitlementState === 'paused') && (
            <p className="text-sm">
              {t(
                'New work is unavailable until your account has an active entitlement. Previously held credits may still settle.',
              )}
            </p>
          )}
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <Detail
              label={t('Members')}
              value={t('{used} of {limit}', {
                used: info.usage.users,
                limit: info.limits.users,
              })}
            />
            <Detail
              label={t('Projects')}
              value={t('{used} of {limit}', {
                used: info.usage.projects,
                limit: info.limits.projects,
              })}
            />
            <Detail
              label={t('Concurrent executions')}
              value={t('{used} of {limit}', {
                used: info.usage.activeExecutions,
                limit: info.limits.concurrency,
              })}
            />
          </dl>
          {(info.usage.pendingUsers > 0 || info.usage.pendingProjects > 0) && (
            <p className="text-sm text-gray-11">
              {t(
                'Pending invitations also reserve {users} member slots and {projects} project slots.',
                {
                  users: info.usage.pendingUsers,
                  projects: info.usage.pendingProjects,
                },
              )}
            </p>
          )}
        </section>
        <Separator />
        <section aria-labelledby="hosted-allowances" className="space-y-4">
          <div>
            <h2 id="hosted-allowances" className="text-base font-semibold">
              {t('Usage & allowances')}
            </h2>
            <p className="mt-1 text-sm text-gray-11">
              {t(
                'Credits cover workflow runs and chat. Held Credits are reserved for work in progress. Managed AI remains subject to service limits.',
              )}
            </p>
          </div>
          <Allowance
            title={t('Credits')}
            meter={info.meters.execution}
            format={quantity}
          />
          <div className="rounded-lg bg-gray-2 p-4 text-sm">
            <h3 className="font-medium">
              {t('Bring your own key on every plan')}
            </h3>
            <p className="mt-1 text-gray-11">
              {t(
                'BYOK is included in every plan and uses Credits. Your provider bills AI usage separately. Managed AI is provided by Sydekyks. BYOK currently supports DeepSeek.',
              )}
            </p>
          </div>
        </section>
        <Separator />
        <section aria-labelledby="hosted-plans" className="space-y-4">
          <div>
            <h2 id="hosted-plans" className="text-base font-semibold">
              {t('Hosted plans')}
            </h2>
            <p className="mt-1 text-sm text-gray-11">
              {t(
                'Monthly allowances. Plan switching is not available yet for an existing subscription.',
              )}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {info.plans.map((plan) => (
              <article
                key={plan.id}
                aria-labelledby={`hosted-plan-${plan.id}`}
                className="flex flex-col rounded-lg border p-5"
              >
                <h3 id={`hosted-plan-${plan.id}`} className="font-semibold">
                  {planName(plan.id)}
                </h3>
                <p className="mt-2 text-xl font-medium">
                  {plan.price
                    ? t('{price} / month', { price: price(plan.price) })
                    : manual
                    ? t('Arrange with Sydekyks')
                    : t('Purchasing unavailable')}
                </p>
                <ul className="my-4 space-y-2 text-sm text-gray-11">
                  <li>
                    {t('{users} members · {projects} projects', {
                      users: plan.limits.users,
                      projects: plan.limits.projects,
                    })}
                  </li>
                  <li>
                    {t('{credits} Credits', {
                      credits: quantity(String(plan.limits.executions)),
                    })}
                  </li>
                  <li>
                    {t('{count} concurrent executions', {
                      count: plan.limits.concurrency,
                    })}
                  </li>
                  <li>{t('BYOK included')}</li>
                  <li>{t('Managed AI is subject to service limits')}</li>
                </ul>
                <div className="mt-auto space-y-2">
                  {manual ? (
                    <p className="text-sm leading-6">
                      {t(
                        'Contact Sydekyks to request this plan. Access and renewal dates change only after the team confirms your payment and entitlement.',
                      )}
                    </p>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={blocked || !plan.checkout.enabled}
                      onClick={() => onCheckout(plan.id)}
                      aria-describedby={`hosted-plan-reason-${plan.id}`}
                      aria-busy={pending === plan.id}
                    >
                      {pending === plan.id
                        ? t('Opening Checkout…')
                        : plan.checkout.continuing
                        ? t('Continue test Checkout')
                        : t('Choose {plan} in test mode', {
                            plan: planName(plan.id),
                          })}
                    </Button>
                  )}
                  <p
                    id={`hosted-plan-reason-${plan.id}`}
                    className="min-h-10 text-xs text-gray-11"
                  >
                    {reason(plan.checkout.reason)}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>
        <Separator />
        <section aria-labelledby="hosted-payments" className="space-y-3">
          <h2 id="hosted-payments" className="text-base font-semibold">
            {t('Payments & invoices')}
          </h2>
          <p className="text-sm text-gray-11">
            {manual
              ? t(
                  'Ask the Sydekyks team for payment instructions, invoices, changes or cancellation. This page shows your current recorded access and Credits; it does not collect payment.',
                )
              : t(
                  'Use Stripe to manage payment details, view invoices or cancel at the end of the paid period. Cancellation does not add a free hosted plan.',
                )}
          </p>
          {!manual && (
            <Button
              variant="outline"
              disabled={blocked || !info.portal.enabled}
              onClick={onPortal}
              aria-describedby="hosted-portal-reason"
              aria-busy={pending === 'portal'}
            >
              {pending === 'portal'
                ? t('Opening Stripe…')
                : t('Open test billing portal')}
              <ExternalLink className="ml-2 size-4" aria-hidden="true" />
            </Button>
          )}
          <p id="hosted-portal-reason" className="text-xs text-gray-11">
            {reason(info.portal.reason)}
          </p>
        </section>
        <p className="text-xs text-gray-11" role="status">
          {t('Last verified {date}', {
            date: new Date(info.serverTime).toLocaleString(),
          })}
        </p>
      </div>
    </CenteredPage>
  );
}
function Allowance({
  title,
  meter,
  format,
}: {
  title: string;
  meter: HostedCustomerBillingOverview['meters']['execution'];
  format: (value: string) => string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-gray-11">
          {meter.validFrom && meter.validUntil
            ? t('{start} – {end}', {
                start: date(meter.validFrom),
                end: date(meter.validUntil),
              })
            : t('No allowance recorded')}
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Detail label={t('Available')} value={format(meter.available)} />
        <Detail label={t('Used')} value={format(meter.consumed)} />
        <Detail label={t('Held')} value={format(meter.reserved)} />
        <Detail label={t('Allowance')} value={format(meter.amount)} />
      </dl>
      {meter.state !== 'active' && (
        <p className="mt-3 text-xs text-gray-11">
          {meter.state === 'revoked'
            ? t('This allowance was revoked; it cannot fund new work.')
            : meter.state === 'expired'
            ? t('This allowance has expired; it cannot fund new work.')
            : t('An active allowance is not available.')}
        </p>
      )}
    </div>
  );
}
function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-gray-11">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums">{value}</dd>
    </div>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <Alert variant="warning">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
function date(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
function quantity(value: string) {
  return BigInt(value).toLocaleString();
}
function price(
  value: NonNullable<HostedCustomerBillingOverview['plans'][number]['price']>,
) {
  const formatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: value.currency,
  });
  return formatter.format(
    value.amountMinor /
      10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2),
  );
}
function planName(id: HostedCustomerBillingOverview['planId']) {
  return id === 'trial'
    ? t('Limited trial')
    : id === 'training'
    ? t('Training')
    : id === 'assessment'
    ? t('Assessment access')
    : id === 'starter'
    ? t('Starter')
    : t('Team');
}
function stateName(state: HostedCustomerBillingOverview['entitlementState']) {
  return state === 'trial'
    ? t('Trial active')
    : state === 'training'
    ? t('Training access')
    : state === 'assessment'
    ? t('Assessment access')
    : state === 'paid'
    ? t('Paid access')
    : state === 'paused'
    ? t('Paused')
    : t('Expired');
}
function reason(value: HostedBillingActionReason | null) {
  if (!value) return '';
  const messages: Record<HostedBillingActionReason, string> = {
    manual_billing: t('Contact Sydekyks for manual billing support.'),
    billing_unavailable: t(
      'Purchasing is not configured. Your verified usage remains available.',
    ),
    account_paused: t('Your account is paused. Contact support.'),
    billing_review: t('Billing needs review before a new purchase.'),
    resource_limit: t(
      'Your members, projects or pending invitations exceed this plan’s limits.',
    ),
    subscription_exists: t(
      'A subscription already exists. Use the billing portal below.',
    ),
    checkout_pending: t(
      'A billing action is already in progress. Refresh to check its status.',
    ),
    session_changed: t(
      'An earlier billing action belongs to another login session. Contact support.',
    ),
    recovery_required: t(
      'An earlier billing action needs review. Contact support before retrying.',
    ),
    customer_missing: t(
      'The billing portal becomes available after a billing customer has been created.',
    ),
  };
  return messages[value];
}
