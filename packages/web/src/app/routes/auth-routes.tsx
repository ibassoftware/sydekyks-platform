import { PageTitle } from '@/app/components/page-title';
import { VerifyEmail } from '@/features/authentication';
import { AcceptInvitation } from '@/features/members';

import { ChangePasswordPage } from './change-password';
import { CreatePlatformPage } from './create-platform';
import { ResetPasswordPage } from './forget-password';
import { SignInPage } from './sign-in';
import { SignUpPage } from './sign-up';

export const authRoutes = [
  {
    path: '/forget-password',
    element: (
      <PageTitle titleKey="Forget Password">
        <ResetPasswordPage />
      </PageTitle>
    ),
  },
  {
    path: '/reset-password',
    element: (
      <PageTitle titleKey="Reset Password">
        <ChangePasswordPage />
      </PageTitle>
    ),
  },
  {
    path: '/sign-in',
    element: (
      <PageTitle titleKey="Sign In">
        <SignInPage />
      </PageTitle>
    ),
  },
  {
    path: '/verify-email',
    element: (
      <PageTitle titleKey="Verify Email">
        <VerifyEmail />
      </PageTitle>
    ),
  },
  {
    path: '/sign-up',
    element: (
      <PageTitle titleKey="Sign Up">
        <SignUpPage />
      </PageTitle>
    ),
  },
  {
    path: '/create-platform',
    element: (
      <PageTitle titleKey="Create Platform">
        <CreatePlatformPage />
      </PageTitle>
    ),
  },
  {
    path: '/invitation',
    element: (
      <PageTitle titleKey="Accept Invitation">
        <AcceptInvitation />
      </PageTitle>
    ),
  },
];
