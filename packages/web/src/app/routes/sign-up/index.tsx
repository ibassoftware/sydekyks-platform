import { Navigate, useLocation } from 'react-router-dom';

import { AuthLanding } from '@/features/authentication';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';

const SignUpPage: React.FC = () => {
  const location = useLocation();
  const hosted = useHostedBillingEnabled();
  if (hosted) return <AuthLanding initialMode="signup" />;
  return <Navigate to={`/sign-in${location.search}`} replace />;
};

SignUpPage.displayName = 'SignUpPage';

export { SignUpPage };
