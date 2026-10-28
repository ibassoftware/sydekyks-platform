import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import {
  BillingError,
  currentBillingSession,
  useBillingSession,
} from './billing-session';
import {
  PartnerPackage,
  partnerPurchaseApi,
  PartnerPurchaseStatus,
} from './partner-purchase-api';

type Props = { selectedPackage?: PartnerPackage | null; disabled?: boolean };
export function PartnerPurchaseSection({
  selectedPackage = null,
  disabled = false,
}: Props) {
  const session = useBillingSession();
  if (!session) return null;
  return (
    <PartnerPurchaseSession
      key={session.epoch}
      session={session}
      selectedPackage={selectedPackage}
      disabled={disabled}
    />
  );
}
function PartnerPurchaseSession({
  session,
  selectedPackage,
  disabled = false,
}: Props & { session: NonNullable<ReturnType<typeof currentBillingSession>> }) {
  const actionLock = useRef(false);
  const [pending, setPending] = useState<PartnerPackage | null>(null);
  const [actionError, setActionError] = useState(false);
  const query = useQuery({
    queryKey: ['partner-purchase', session.epoch],
    queryFn: ({ signal }) => partnerPurchaseApi.status(session, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (result) =>
      ['prepared', 'ready'].includes(result.state.data?.purchase?.state ?? '')
        ? 15_000
        : false,
  });
  const status = query.data;
  if (
    query.error instanceof BillingError &&
    ['denied', 'session'].includes(query.error.kind)
  )
    return null;
  const blocked =
    disabled ||
    query.isFetching ||
    query.isError ||
    pending !== null ||
    !status;
  const showOffers =
    status &&
    (!status.purchase ||
      status.available ||
      ['prepared', 'ready'].includes(status.purchase.state));
  async function checkout(selected: PartnerPackage) {
    if (
      actionLock.current ||
      blocked ||
      status?.billingMode !== 'stripe_test' ||
      !(
        status?.available ||
        (status?.purchase?.state === 'ready' &&
          status.purchase.package === selected)
      )
    )
      return;
    actionLock.current = true;
    setPending(selected);
    setActionError(false);
    try {
      await partnerPurchaseApi.checkout(session, selected);
    } catch {
      setActionError(true);
    } finally {
      actionLock.current = false;
      setPending(null);
      void query.refetch();
    }
  }
  return (
    <section
      aria-labelledby="partner-purchase-title"
      className="space-y-4 border-t pt-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="partner-purchase-title" className="text-base font-semibold">
          {t('Partner training')}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching || pending !== null}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? t('Checking…') : t('Check purchase status')}
        </Button>
      </div>
      {showOffers && (
        <p className="max-w-prose text-sm text-gray-11">
          {t(
            'Both packages include your own training workspace for 12 calendar months, 300 Credits each month and two exam attempts. The qualification requirements are the same. Partner approval and certification require independent assessment; client subscriptions are purchased separately.'
          )}
        </p>
      )}
      {!status && query.isLoading && (
        <p role="status" className="text-sm text-gray-11">
          {t('Loading Partner purchase options…')}
        </p>
      )}
      {query.isError && (
        <Notice>
          {t(
            'Purchase status could not be checked. Refresh before continuing to payment.'
          )}
        </Notice>
      )}
      {actionError && (
        <Notice>
          {t(
            'Checkout could not be opened. Check purchase status before trying again; payment may still be pending.'
          )}
        </Notice>
      )}
      {status?.billingMode === 'manual' && (
        <Notice>
          {t(
            'Partner purchases are handled directly by Sydekyks. Contact the team to arrange payment and receipt activation.'
          )}
        </Notice>
      )}
      {status?.billingMode === 'stripe_test' && (
        <Notice>
          {t(
            'Stripe test mode. These packages use sandbox payments. Access begins only after the server verifies the paid purchase.'
          )}
        </Notice>
      )}
      {status?.purchase && (
        <p role="status" className="text-sm font-medium">
          {purchaseMessage(status)}
        </p>
      )}
      {!status?.purchase &&
        status?.billingMode === 'stripe_test' &&
        !status.available && (
          <p role="status" className="text-sm text-gray-11">
            {status.reason === 'unconfigured'
              ? t(
                  'Partner checkout is being configured. Contact the team to arrange a purchase.'
                )
              : t(
                  'This workspace needs a review before a Partner purchase. Use your own training workspace and contact the team for help.'
                )}
          </p>
        )}
      {showOffers && (
        <div className="divide-y border-y">
          {(['core', 'guided'] as const).map((selected) => (
            <div
              key={selected}
              className={`flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between ${
                selectedPackage === selected ? 'bg-accent-3' : ''
              }`}
            >
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">
                  {selected === 'core' ? t('Core') : t('Guided')}{' '}
                  <span className="ml-2 font-normal tabular-nums">
                    {selected === 'core' ? t('$1,000 once') : t('$1,200 once')}
                  </span>
                </h3>
                <p className="text-sm text-gray-11">
                  {selected === 'core'
                    ? t('Includes 2 hours of coaching.')
                    : t('Includes 4 hours of coaching.')}
                </p>
                {selectedPackage === selected && (
                  <p className="text-xs text-gray-11">
                    {t(
                      'Selected on the website. Review the package before continuing.'
                    )}
                  </p>
                )}
              </div>
              {status.billingMode === 'stripe_test' ? (
                <Button
                  variant="outline"
                  disabled={
                    blocked ||
                    !(
                      status?.available ||
                      (status?.purchase?.state === 'ready' &&
                        status.purchase.package === selected)
                    )
                  }
                  onClick={() => void checkout(selected)}
                  className="w-full sm:w-auto"
                >
                  {pending === selected
                    ? t('Opening Checkout…')
                    : selected === 'core'
                    ? t('Buy Core in test mode')
                    : t('Buy Guided in test mode')}
                </Button>
              ) : (
                <p className="text-sm font-medium">
                  {t('Arrange with Sydekyks')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {showOffers && (
        <p className="text-xs text-gray-11">
          {t(
            'Unused Credits do not roll over. A full refund revokes access funded by that purchase; a partial refund currently preserves it. Existing training terms require team review before another purchase.'
          )}
        </p>
      )}
    </section>
  );
}
function Notice({ children }: { children: string }) {
  return (
    <Alert role="status">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
function purchaseMessage(status: PartnerPurchaseStatus) {
  const purchase = status.purchase;
  if (!purchase) return '';
  if (purchase.state === 'fulfilled')
    return purchase.refundedMinor > 0
      ? t(
          'Purchase verified. Your training access remains active after a partial refund.'
        )
      : t(
          'Purchase verified. Your training workspace and course access are ready.'
        );
  if (purchase.state === 'refunded')
    return t(
      'Fully refunded. The access funded by this purchase has been revoked.'
    );
  if (purchase.state === 'review')
    return t(
      'This purchase needs review. Contact the team before attempting another payment.'
    );
  return t(
    'Payment confirmation is pending. Check purchase status after completing Checkout.'
  );
}
