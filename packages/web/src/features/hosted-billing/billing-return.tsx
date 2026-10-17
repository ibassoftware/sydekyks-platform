import { Navigate, useSearchParams } from 'react-router-dom';

import { useHostedBillingEnabled } from './service-mode';

// This alias only navigates. It never accepts a session id or confirms payment.
export function HostedBillingReturn() {
  const hosted = useHostedBillingEnabled();
  const [params] = useSearchParams();
  const value = params.get('checkout');
  const search =
    value === 'success' || value === 'cancel' ? `?checkout=${value}` : '';
  return (
    <Navigate
      replace
      to={hosted ? `/platform/billing${search}` : '/platform/projects'}
    />
  );
}
