import {
  HostedBillingActionReason,
  HostedCustomerBillingOverview,
} from '@activepieces/shared';
import { t } from 'i18next';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { ReactNode, useState } from 'react';

import {
  CheckoutIntentReview,
  useCheckoutIntent,
} from './checkout-intent-review';
import { PartnerPurchaseSection } from './partner-purchase-section';

import { CenteredPage } from '@/components/custom/centered-page';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatCreditUnits } from '@/lib/hosted-credit-units';

type Props = {
  overview: HostedCustomerBillingOverview;
  stale: boolean;
  refreshing: boolean;
  pending: string | null;
  actionError: boolean;
  checkoutReturn: string | null;
  onRefresh: () => void;
  onCheckout: (id: 'starter' | 'team' | 'scale') => void;
  onPortal: () => void;
  onPlanChange?: (id: 'starter' | 'team' | 'scale') => void;
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
  onPlanChange,
}: Props) {
  const [reviewPlan, setReviewPlan] = useState<
    'starter' | 'team' | 'scale' | null
  >(null);
  const { intent } = useCheckoutIntent();
  const selectedPlan =
    intent?.offer === 'starter'
      ? 'starter'
      : intent?.offer === 'growth'
      ? 'team'
      : null;
  const selectedPackage =
    intent?.offer === 'partner-core'
      ? 'core'
      : intent?.offer === 'partner-guided'
      ? 'guided'
      : null;
  const partner =
    info.accountKind === 'partner' ||
    (!info.accountKind && ['training', 'assessment'].includes(info.planId));
  const eligiblePlans = partner
    ? []
    : info.plans.filter(
        (plan) => plan.checkout.enabled || plan.checkout.continuing,
      );
  const showPartnerPurchase =
    !partner && info.planId === 'trial' && selectedPackage !== null;
  const currentPlan = info.plans.find((plan) => plan.id === info.planId);
  const reviewedPlan = info.plans.find((plan) => plan.id === reviewPlan);
  const manual = info.billingMode === 'manual' || info.manualFunding === true;
  const blocked = stale || refreshing || pending !== null;
  return (
    <CenteredPage
      title={t('Billing')}
      description={
        partner
          ? t('Your Partner package, hosting term and Credits.')
          : t('Your workspace plan, Credits and payments.')
      }
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
        {!partner && <CheckoutIntentReview />}
        {!manual && (
          <Alert role="status">
            <AlertDescription>
              {t(
                'Test billing. Stripe actions use test mode; no live payments are enabled.',
              )}
            </AlertDescription>
          </Alert>
        )}
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
              {partner ? partnerPackageName(info) : planName(info.planId)}
            </h2>
            <span className="rounded-md border px-2 py-1 text-xs font-medium">
              {stateName(info.entitlementState)}
            </span>
          </div>
          <p className="text-sm text-gray-11">
            {partner
              ? info.planId === 'assessment'
                ? t(
                    'One-time assessment allowance. Contact Sydekyks for training.',
                  )
                : t('Contact Sydekyks to renew hosting after this term.')
              : info.planId === 'trial'
              ? t(
                  'Your trial has limited time and Credits. Contact Sydekyks to arrange continued hosting.',
                )
              : t(
                  'Your plan and Credits are shared across this workspace. Assigned Partner and Sydekyks support access does not use client seats.',
                )}
          </p>
          <dl className="grid gap-x-6 gap-y-4 rounded-lg bg-gray-2 p-4 text-sm sm:grid-cols-3">
            <Detail
              label={
                info.planId === 'trial' ? t('Trial ends') : t('Hosting ends')
              }
              value={recordedDate(
                info.hostingEndsAt ??
                  (info.planId === 'trial' ? info.trialEndsAt : null),
              )}
            />
            <Detail
              label={t('Renewal')}
              value={
                info.renewalDueAt
                  ? date(info.renewalDueAt)
                  : info.planId === 'assessment'
                  ? t('One-time assessment')
                  : partner
                  ? t('Arrange with Sydekyks')
                  : t('No renewal date recorded')
              }
            />
            <Detail
              label={t('Next Credit allowance')}
              value={
                info.nextCreditAllowanceAt
                  ? date(info.nextCreditAllowanceAt)
                  : t('No funded allowance scheduled')
              }
            />
          </dl>
          {(info.entitlementState === 'expired' ||
            info.entitlementState === 'paused') && (
            <p className="text-sm">
              {t(
                'New work is unavailable until your account has an active entitlement. Previously held credits may still settle.',
              )}
            </p>
          )}
          {currentPlan?.price && (
            <p className="text-sm font-medium tabular-nums">
              {t('Plan price: {price} / month', {
                price: price(currentPlan.price),
              })}
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
              label={t('Runs in progress')}
              value={t('{used} of {limit}', {
                used: info.usage.activeExecutions,
                limit: info.limits.concurrency,
              })}
            />
          </dl>
          <p className="text-sm text-gray-11">
            {t(
              'Up to {limit} runs can be active at the same time. This limit is included in your plan; each run uses your shared Credits.',
              { limit: info.limits.concurrency },
            )}
          </p>
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
              {t('Credits')}
            </h2>
            <p className="mt-1 text-sm text-gray-11">
              {t('One balance for workflows, messages and Sydekyks AI.')}
            </p>
          </div>
          <Allowance
            title={t('Current Credit period')}
            meter={info.meters.execution}
            format={quantity}
          />
          <details className="text-sm text-gray-11">
            <summary className="w-fit cursor-pointer underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
              {t('How Credits work')}
            </summary>
            <p className="mt-2 leading-relaxed">
              {t(
                'Held Credits are reserved for work in progress; unused holds return to your available balance. Unused Credits do not roll over. With your own AI key, runs use Credits and your provider bills AI usage separately.',
              )}
            </p>
          </details>
        </section>
        {eligiblePlans.length > 0 && (
          <>
            <Separator />
            <section aria-labelledby="hosted-plans" className="space-y-4">
              <div>
                <h2 id="hosted-plans" className="text-base font-semibold">
                  {t('Available plan options')}
                </h2>
                <p className="mt-1 text-sm text-gray-11">
                  {t(
                    'Review the plan before continuing to test Checkout. Access changes only after verified payment.',
                  )}
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {eligiblePlans.map((plan) => (
                  <article
                    key={plan.id}
                    aria-labelledby={`hosted-plan-${plan.id}`}
                    className="flex flex-col rounded-lg border p-5"
                  >
                    {selectedPlan === plan.id && (
                      <p className="mb-2 text-sm font-medium">
                        {t('Selected for review')}
                      </p>
                    )}
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
                      <li>{t('Sydekyks AI uses the same Credits balance')}</li>
                    </ul>
                    <div className="mt-auto space-y-2">
                      {plan.salesAssisted ? (
                        <p className="text-sm leading-6">
                          {t(
                            'Contact Sydekyks for a capacity review before activating Scale.',
                          )}
                        </p>
                      ) : manual ? (
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
          </>
        )}
        {!partner && ['starter', 'team', 'scale'].includes(info.planId) && (
          <section aria-labelledby="subscription-actions" className="space-y-4">
            <h2 id="subscription-actions" className="text-base font-semibold">
              {t('Manage subscription')}
            </h2>
            {info.cancelAtPeriodEnd ? (
              <p role="status" className="text-sm">
                {t(
                  'Cancellation is scheduled for the end of your paid term. Use the billing portal to review it.',
                )}
              </p>
            ) : info.pendingPlanId && info.pendingChangeAt ? (
              <p role="status" className="text-sm">
                {t(
                  '{plan} is selected for your next renewal on {date}. Your current plan and remaining Credits stay in place until then.',
                  {
                    plan: planName(info.pendingPlanId),
                    date: new Date(info.pendingChangeAt).toLocaleDateString(),
                  },
                )}
              </p>
            ) : null}
            {manual ? (
              <p className="text-sm text-gray-11">
                {t(
                  'This account was funded manually and has no Stripe subscription. Contact Sydekyks to arrange a plan change or cancellation; no automatic card charge is scheduled here.',
                )}
              </p>
            ) : (
              <>
                <p className="max-w-prose text-sm text-gray-11">
                  {t(
                    'Choose a plan at any time for your next renewal. Nothing is charged today. The next paid invoice activates the new plan and its monthly Credits. Cancellation is available in the billing portal below.',
                  )}
                </p>
                <div className="divide-y border-y">
                  {info.plans.map((plan) => (
                    <div
                      key={plan.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-4"
                    >
                      <div className="space-y-1">
                        <p className="font-medium text-sm">
                          {planName(plan.id)}
                          {plan.price
                            ? ` · ${price(plan.price)} / ${t('month')}`
                            : ''}
                        </p>
                        <p className="text-sm text-gray-11">
                          {t(
                            '{users} users · {credits} monthly Credits · {runs} simultaneous runs',
                            {
                              users: plan.limits.users,
                              credits: quantity(String(plan.limits.executions)),
                              runs: plan.limits.concurrency,
                            },
                          )}
                        </p>
                      </div>
                      {plan.salesAssisted ? (
                        <p className="max-w-64 text-sm text-gray-11">
                          {t('Contact Sydekyks for a capacity review.')}
                        </p>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={
                            blocked ||
                            !info.planChangesEnabled ||
                            plan.checkout.reason === 'resource_limit' ||
                            (plan.id === info.planId && !info.pendingPlanId) ||
                            plan.id === info.pendingPlanId ||
                            !onPlanChange
                          }
                          onClick={() => setReviewPlan(plan.id)}
                        >
                          {plan.id === info.pendingPlanId
                            ? t('Selected for renewal')
                            : plan.id === info.planId && !info.pendingPlanId
                            ? t('Current plan')
                            : t('Review {plan}', { plan: planName(plan.id) })}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                {reviewPlan && (
                  <div
                    className="space-y-3 rounded-lg border p-4"
                    role="region"
                    aria-label={t('Review plan change')}
                  >
                    <h3 className="font-medium">
                      {t('Confirm {plan} for your next renewal', {
                        plan: planName(reviewPlan),
                      })}
                    </h3>
                    <p className="text-sm font-medium">
                      {t('Effective {date}. No charge today.', {
                        date: new Date(
                          info.hostingEndsAt ?? info.validUntil,
                        ).toLocaleDateString(),
                      })}
                    </p>
                    {reviewedPlan?.price && (
                      <p className="text-sm">
                        {t(
                          '{price} per month · {users} users · {credits} monthly Credits · {runs} simultaneous runs',
                          {
                            price: price(reviewedPlan.price),
                            users: reviewedPlan.limits.users,
                            credits: quantity(
                              String(reviewedPlan.limits.executions),
                            ),
                            runs: reviewedPlan.limits.concurrency,
                          },
                        )}
                      </p>
                    )}
                    <p className="text-sm">
                      {t(
                        'Your current paid term remains unchanged. The new monthly price, user limit and Credits apply only after the renewal invoice is paid. If your users or Command Centers exceed the new limit at renewal, access may pause until capacity is resolved.',
                      )}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={blocked || !info.planChangesEnabled}
                        onClick={() => {
                          onPlanChange?.(reviewPlan);
                          setReviewPlan(null);
                        }}
                      >
                        {t('Confirm plan for renewal')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={blocked}
                        onClick={() => setReviewPlan(null)}
                      >
                        {t('Keep current selection')}
                      </Button>
                    </div>
                  </div>
                )}
                {!info.planChangesEnabled && !info.cancelAtPeriodEnd && (
                  <p className="text-sm text-gray-11">
                    {t(
                      'Plan changes are unavailable until an active Stripe subscription is verified. Refresh or contact Sydekyks for help.',
                    )}
                  </p>
                )}
              </>
            )}
          </section>
        )}
        {showPartnerPurchase && (
          <PartnerPurchaseSection
            selectedPackage={selectedPackage}
            disabled={blocked}
          />
        )}
        <Separator />
        <section aria-labelledby="hosted-payments" className="space-y-3">
          <h2 id="hosted-payments" className="text-base font-semibold">
            {t('Payments & invoices')}
          </h2>
          <p className="text-sm text-gray-11">
            {manual
              ? t(
                  'Contact Sydekyks for payment instructions, invoices, plan changes or cancellation.',
                )
              : t(
                  'Use Stripe to manage payment details, view invoices or cancel at the end of the paid period. Cancellation does not add a free hosted plan.',
                )}
          </p>
          {!manual && !partner && (
            <Button
              variant="outline"
              disabled={blocked || !info.portal.enabled}
              onClick={onPortal}
              aria-describedby="hosted-portal-reason"
              aria-busy={pending === 'portal'}
            >
              {pending === 'portal'
                ? t('Opening Stripe…')
                : t('Manage payments or cancel in Stripe')}
              <ExternalLink className="ml-2 size-4" aria-hidden="true" />
            </Button>
          )}
          {!manual && !partner && (
            <p id="hosted-portal-reason" className="text-xs text-gray-11">
              {reason(info.portal.reason)}
            </p>
          )}
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
        <Detail label={t('Period allowance')} value={format(meter.amount)} />
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
function partnerPackageName(info: HostedCustomerBillingOverview) {
  if (info.planId === 'assessment') return t('Partner assessment');
  if (info.trainingPackage === 'starter') return t('Partner Starter');
  if (info.trainingPackage === 'core') return t('Partner Core');
  if (info.trainingPackage === 'launch') return t('Partner Guided');
  return t('Partner training');
}
function recordedDate(value: string | null | undefined) {
  return value ? date(value) : t('Not recorded');
}
function date(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
function quantity(value: string) {
  return formatCreditUnits(value);
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
    : id === 'team'
    ? t('Growth')
    : t('Scale');
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
    sales_assisted: t(
      'This plan requires a capacity review. Contact Sydekyks.',
    ),
    customer_missing: t(
      'The billing portal becomes available after a billing customer has been created.',
    ),
  };
  return messages[value];
}
