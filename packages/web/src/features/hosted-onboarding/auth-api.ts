import {
  AuthenticationResponse,
  HostedOnboardingOffer,
  HostedOnboardingStatus,
} from '@activepieces/shared';

import { api } from '@/lib/api';

import {
  assertAuthSession,
  currentAuthSession,
  HostedAuthError,
} from './auth-session';

type Session = ReturnType<typeof currentAuthSession>;
async function request<T>(
  session: Session,
  operation: () => Promise<T>,
): Promise<T> {
  assertAuthSession(session);
  try {
    const result = await operation();
    assertAuthSession(session);
    return result;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof HostedAuthError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    const code = api.isError(error)
      ? (error.response?.data as { code?: unknown })?.code
      : undefined;
    const kind =
      status === 429
        ? 'rate'
        : code === 'EMAIL_IS_NOT_VERIFIED'
        ? 'verification'
        : code === 'INVALID_OTP'
        ? 'code'
        : code === 'INVALID_CREDENTIALS'
        ? 'credentials'
        : code === 'HOSTING_TRIAL_ALREADY_USED'
        ? 'trial'
        : code === 'HOSTING_OPERATOR_PROVISIONING_REQUIRED'
        ? 'approval'
        : code === 'VALIDATION'
        ? 'captcha'
        : status === 401 ||
          code === 'SESSION_EXPIRED' ||
          code === 'HOSTING_SESSION_EXPIRED'
        ? 'session'
        : code === 'HOSTING_ACCESS_DENIED' ||
          code === 'AUTHORIZATION' ||
          code === 'USER_IS_INACTIVE'
        ? 'denied'
        : 'unavailable';
    // Plain bounded errors only; Axios configs include credentials and must not escape.
    throw new HostedAuthError(kind);
  }
}
async function auth(session: Session, operation: () => Promise<unknown>) {
  const parsed = AuthenticationResponse.safeParse(
    await request(session, operation),
  );
  if (!parsed.success) throw new HostedAuthError('unavailable');
  return parsed.data;
}
export const hostedAuthApi = {
  async offer(session: Session, signal: AbortSignal) {
    const result = HostedOnboardingOffer.safeParse(
      await request(session, () =>
        api.sessionScoped('/v1/hosting/onboarding', { signal }, true),
      ),
    );
    if (!result.success) throw new HostedAuthError('unavailable');
    return result.data;
  },
  sendCode: (session: Session, email: string, captchaToken: string) =>
    request(session, () =>
      api.sessionScoped<void>(
        '/v1/hosting/onboarding/email-code',
        { method: 'POST', data: { email, captchaToken } },
        true,
      ),
    ),
  verifyCode: (session: Session, email: string, code: string) =>
    auth(session, () =>
      api.sessionScoped(
        '/v1/hosting/onboarding/email-code/verify',
        { method: 'POST', data: { email, code } },
        true,
      ),
    ),
  signIn: (session: Session, email: string, password: string) =>
    auth(session, () =>
      api.sessionScoped(
        '/v1/authentication/sign-in',
        { method: 'POST', data: { email, password } },
        true,
      ),
    ),
  complete: (session: Session, fullName: string) =>
    auth(session, () =>
      api.sessionScoped('/v1/authentication/complete-sign-up', {
        method: 'POST',
        data: { fullName },
      }),
    ),
  resendVerification: (session: Session, email: string, captchaToken: string) =>
    request(session, () =>
      api.sessionScoped<void>(
        '/v1/hosting/onboarding/verification-code',
        { method: 'POST', data: { email, captchaToken } },
        true,
      ),
    ),
  verifyPasswordEmail: (
    session: Session,
    email: string,
    code: string,
    newPassword: string,
  ) =>
    auth(session, () =>
      api.sessionScoped(
        '/v1/hosting/verify-email',
        { method: 'POST', data: { email, code, newPassword } },
        true,
      ),
    ),
  async status(session: Session, signal: AbortSignal) {
    const result = HostedOnboardingStatus.safeParse(
      await request(session, () =>
        api.sessionScoped('/v1/hosting/onboarding/status', { signal }),
      ),
    );
    if (!result.success) throw new HostedAuthError('unavailable');
    if (
      result.data.userId !== session.id ||
      result.data.platformId !== session.platformId
    )
      throw new HostedAuthError('denied');
    return result.data;
  },
};
