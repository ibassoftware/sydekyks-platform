import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { CenteredPage } from '@/components/custom/centered-page';
import { Button } from '@/components/ui/button';
import { useHostedOperatorAccess } from '@/features/hosted-operator/operator-api';

import { hostedBillingApi } from './billing-api';
import { HostedBillingOperationsView } from './billing-operations-view';
import {
  BillingError,
  assertBillingSession,
  useBillingSession,
} from './billing-session';
import { HostedBillingView } from './billing-view';

export function HostedBillingPage() {
  const session = useBillingSession();
  const operator = useHostedOperatorAccess();
  if (session && operator.isPending) {
    return (
      <CenteredPage title={t('Billing')}>
        <p role="status" className="py-6 text-sm text-gray-11">
          {t('Checking billing access…')}
        </p>
      </CenteredPage>
    );
  }
  if (session && operator.allowed) return <HostedBillingOperationsView />;
  if (session && operator.isError) {
    return (
      <BillingFailure
        message={t(
          'Billing access could not be checked. Refresh to try again.',
        )}
        onRefresh={() => void operator.refetch()}
      />
    );
  }
  // Remount on every credential change, including renewal for the same user.
  return session ? (
    <SessionBillingPage key={session.epoch} session={session} />
  ) : (
    <BillingFailure message={t('Sign in again to view billing.')} />
  );
}
function SessionBillingPage({
  session,
}: {
  session: NonNullable<ReturnType<typeof useBillingSession>>;
}) {
  const client = useQueryClient();
  const [params] = useSearchParams();
  const checkoutReturn = params.get('checkout');
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const key = [
    'hosted-billing',
    session.epoch,
    session.platformId,
    session.userId,
  ];
  const query = useQuery({
    queryKey: key,
    enabled: !accessRevoked,
    queryFn: ({ signal }) => hostedBillingApi.overview(session, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const { refetch, data } = query;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void client.cancelQueries({
        queryKey: ['hosted-billing', session.epoch],
      });
      client.removeQueries({ queryKey: ['hosted-billing', session.epoch] });
    };
  }, [client, session]);
  useEffect(() => {
    if (!data || accessRevoked) return;
    const remaining = Date.parse(data.validUntil) - Date.parse(data.serverTime);
    if (remaining <= 0) return;
    const timer = setTimeout(
      () => void refetch(),
      Math.min(2_147_483_647, remaining + 100),
    );
    return () => clearTimeout(timer);
  }, [data, refetch, accessRevoked]);
  const denied =
    accessRevoked ||
    (query.error instanceof BillingError &&
      ['session', 'denied'].includes(query.error.kind));
  useEffect(() => {
    if (denied) {
      setAccessRevoked(true);
      client.removeQueries({ queryKey: ['hosted-billing', session.epoch] });
    }
  }, [client, denied, session]);
  useEffect(() => {
    if (checkoutReturn !== 'success' || denied) return;
    // Return parameters only trigger bounded reads. Only verified server evidence grants access.
    const timers = [5_000, 15_000, 30_000].map((delay) =>
      setTimeout(() => {
        try {
          assertBillingSession(session);
          void refetch();
        } catch {
          /* Session was replaced. */
        }
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [checkoutReturn, denied, refetch, session]);
  async function open(
    kind: 'checkout' | 'portal',
    planId?: 'starter' | 'team' | 'scale',
  ) {
    if (actionLock.current || query.isError || query.isFetching) return;
    actionLock.current = true;
    setPending(planId ?? kind);
    setActionError(false);
    try {
      await hostedBillingApi.open(session, kind, planId);
    } catch (error) {
      if (
        error instanceof BillingError &&
        ['session', 'denied'].includes(error.kind)
      ) {
        if (mounted.current) setAccessRevoked(true);
        return;
      }
      if (mounted.current) {
        setActionError(true);
        void refetch();
      }
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending(null);
    }
  }
  async function changePlan(planId: 'starter' | 'team' | 'scale') {
    if (actionLock.current || query.isError || query.isFetching) return;
    actionLock.current = true;
    setPending(`change:${planId}`);
    setActionError(false);
    try {
      await hostedBillingApi.changePlan(session, planId);
      if (mounted.current) await refetch();
    } catch (error) {
      if (
        error instanceof BillingError &&
        ['session', 'denied'].includes(error.kind)
      ) {
        if (mounted.current) setAccessRevoked(true);
      } else if (mounted.current) {
        setActionError(true);
        void refetch();
      }
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending(null);
    }
  }
  if (denied)
    return (
      <BillingFailure
        message={t(
          'Your billing access changed. Sign in again or ask a platform administrator.',
        )}
      />
    );
  if (query.isError && !query.data)
    return (
      <BillingFailure
        message={t('Billing is unavailable. Try refreshing in a moment.')}
        onRefresh={() => void refetch()}
      />
    );
  if (!query.data)
    return (
      <CenteredPage title={t('Billing & subscription')}>
        <p role="status" className="py-6 text-sm text-gray-11">
          {t('Loading billing details…')}
        </p>
      </CenteredPage>
    );
  if (query.data.accountKind === 'platform_admin') {
    return (
      <BillingFailure
        message={t(
          'Administrative billing access needs to be verified. Refresh the page to try again.',
        )}
      />
    );
  }
  return (
    <HostedBillingView
      overview={query.data}
      stale={query.isError}
      refreshing={query.isFetching}
      pending={pending}
      actionError={actionError}
      checkoutReturn={checkoutReturn}
      onRefresh={() => void refetch()}
      onCheckout={(id) => void open('checkout', id)}
      onPortal={() => void open('portal')}
      onPlanChange={(id) => void changePlan(id)}
    />
  );
}
function BillingFailure({
  message,
  onRefresh,
}: {
  message: string;
  onRefresh?: () => void;
}) {
  return (
    <CenteredPage title={t('Billing & subscription')}>
      <div role="alert" className="space-y-4 text-sm">
        <p>{message}</p>
        {onRefresh && (
          <Button variant="outline" onClick={onRefresh}>
            {t('Refresh')}
          </Button>
        )}
      </div>
    </CenteredPage>
  );
}
