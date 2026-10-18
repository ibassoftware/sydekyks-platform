import { ApFlagId, AuthenticationResponse } from '@activepieces/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { FullLogo } from '@/components/custom/full-logo';
import { TurnstileWidget } from '@/features/authentication/components/auth-landing/turnstile-widget';
import { flagsHooks } from '@/hooks/flags-hooks';
import { authenticationSession } from '@/lib/authentication-session';
import { publicLinkUtils } from '@/lib/public-link-utils';

import { hostedAuthApi } from './auth-api';
import {
  acceptHostedResponse,
  assertAuthSession,
  HostedAuthError,
  useHostedAuthSession,
} from './auth-session';
import { AuthStage, HostedAuthView } from './auth-view';

export function HostedAuthLanding({
  initialMode = 'signin',
  initialStage = 'email',
}: {
  initialMode?: 'signup' | 'signin';
  initialStage?: 'email' | 'verification';
}) {
  const session = useHostedAuthSession();
  return (
    <SessionAuth
      key={session.epoch}
      session={session}
      initialMode={initialMode}
      initialStage={initialStage}
    />
  );
}
function SessionAuth({
  session,
  initialMode,
  initialStage,
}: {
  session: ReturnType<typeof useHostedAuthSession>;
  initialMode: 'signup' | 'signin';
  initialStage: 'email' | 'verification';
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const terms = flagsHooks.useFlag<string>(ApFlagId.TERMS_OF_SERVICE_URL).data;
  const privacy = flagsHooks.useFlag<string>(ApFlagId.PRIVACY_POLICY_URL).data;
  const legalLinks = [
    { label: t('Terms of Service'), url: terms },
    { label: t('Privacy Policy'), url: privacy },
  ].filter(
    (link): link is { label: string; url: string } =>
      !!link.url && publicLinkUtils.isAllowed({ url: link.url }),
  );
  const location = useLocation();
  const [stage, setStage] = useState<AuthStage>(
    session.kind === 'user'
      ? 'ready'
      : session.kind === 'onboarding'
      ? 'details'
      : initialStage,
  );
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<HostedAuthError['kind'] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const [captchaReset, setCaptchaReset] = useState(0);
  const mounted = useRef(true),
    locked = useRef(false),
    attempt = useRef(0);
  const denied = error === 'session' || error === 'denied';
  const prefix = ['hosted-onboarding', session.epoch];
  const offer = useQuery({
    queryKey: [...prefix, 'offer'],
    queryFn: ({ signal }) => hostedAuthApi.offer(session, signal),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const status = useQuery({
    queryKey: [...prefix, 'status', session.platformId, session.id],
    queryFn: ({ signal }) => hostedAuthApi.status(session, signal),
    enabled: session.kind === 'user' && !denied,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (initialStage === 'verification' && location.search)
      navigate(location.pathname, { replace: true });
  }, [initialStage, location.search, location.pathname, navigate]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void client.cancelQueries({
        queryKey: ['hosted-onboarding', session.epoch],
      });
      client.removeQueries({ queryKey: ['hosted-onboarding', session.epoch] });
    };
  }, [client, session]);
  const statusError =
    status.error instanceof HostedAuthError ? status.error.kind : null;
  useEffect(() => {
    if (statusError === 'session' || statusError === 'denied') {
      setError(statusError);
      client.removeQueries({
        queryKey: ['hosted-onboarding', session.epoch, 'status'],
      });
    }
  }, [statusError, client, session]);
  const { data: access, refetch: refreshStatus } = status;
  useEffect(() => {
    if (!access || denied) return;
    const remaining =
      Date.parse(access.validUntil) - Date.parse(access.serverTime);
    if (remaining <= 0) return;
    const timer = setTimeout(
      () => void refreshStatus(),
      Math.min(2_147_483_647, remaining + 100),
    );
    return () => clearTimeout(timer);
  }, [access, refreshStatus, denied]);
  useEffect(() => {
    const tick = () =>
      setCooldown(Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)));
    tick();
    if (!cooldownUntil) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);
  const unavailable = useCallback(() => {
    setCaptchaToken(undefined);
    setError('captcha');
  }, []);
  const spendCaptcha = () => {
    setCaptchaToken(undefined);
    setCaptchaReset((value) => value + 1);
  };
  async function run(
    operation: (
      canApply: () => boolean,
    ) => Promise<AuthenticationResponse | void>,
  ) {
    if (locked.current || denied) return;
    locked.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    const currentAttempt = ++attempt.current;
    try {
      assertAuthSession(session);
      const result = await operation(
        () => mounted.current && attempt.current === currentAttempt,
      );
      if (result && mounted.current && attempt.current === currentAttempt)
        accept(result);
    } catch (failure) {
      if (mounted.current && attempt.current === currentAttempt)
        setError(
          failure instanceof HostedAuthError ? failure.kind : 'unavailable',
        );
    } finally {
      locked.current = false;
      if (mounted.current && attempt.current === currentAttempt)
        setPending(false);
    }
  }
  function accept(response: Parameters<typeof acceptHostedResponse>[0]) {
    if (!mounted.current) return;
    acceptHostedResponse(response, session, () => client.clear());
  }
  function onSubmit(data: FormData) {
    const address = String(data.get('email') ?? email)
      .trim()
      .toLowerCase();
    void run(async (canApply) => {
      if (stage === 'email') {
        if (!captchaToken || !offer.data?.emailCodesAvailable || cooldown > 0)
          return;
        setEmail(address);
        try {
          await hostedAuthApi.sendCode(session, address, captchaToken);
          if (canApply()) {
            setCooldownUntil(Date.now() + 60_000);
            setStage('code');
          }
        } finally {
          if (canApply()) spendCaptcha();
        }
      } else if (stage === 'code')
        return hostedAuthApi.verifyCode(
          session,
          email,
          String(data.get('code') ?? '').trim(),
        );
      else if (stage === 'password') {
        setEmail(address);
        return hostedAuthApi.signIn(
          session,
          address,
          String(data.get('password') ?? ''),
        );
      } else if (stage === 'details')
        return hostedAuthApi.complete(
          session,
          String(data.get('fullName') ?? '').trim(),
        );
      else if (stage === 'verification') {
        setEmail(address);
        if (data.get('newPassword') !== data.get('confirmPassword')) {
          setNotice(t('The new passwords do not match. Enter them again.'));
          return;
        }
        return hostedAuthApi.verifyPasswordEmail(
          session,
          address,
          String(data.get('code') ?? '').trim(),
          String(data.get('newPassword') ?? ''),
        );
      }
    });
  }
  function resend(address = email) {
    void run(async (canApply) => {
      if (!captchaToken || !offer.data?.emailCodesAvailable || cooldown > 0)
        return;
      setEmail(address.trim().toLowerCase());
      try {
        if (stage === 'verification')
          await hostedAuthApi.resendVerification(
            session,
            address.trim().toLowerCase(),
            captchaToken,
          );
        else await hostedAuthApi.sendCode(session, email, captchaToken);
        if (canApply()) {
          setCooldownUntil(Date.now() + 60_000);
          setNotice(
            t(
              'If this address is eligible, a code has been sent. Check your inbox and spam folder.',
            ),
          );
        }
      } finally {
        if (canApply()) spendCaptcha();
      }
    });
  }
  const readError = offer.isError || status.isError;
  const challenge =
    ['email', 'code', 'verification'].includes(stage) &&
    offer.data?.emailCodesAvailable ? (
      <TurnstileWidget
        onToken={setCaptchaToken}
        onUnavailable={unavailable}
        resetSignal={captchaReset}
      />
    ) : undefined;
  return (
    <HostedAuthView
      stage={stage}
      approvalPending={error === 'approval'}
      mode={initialMode}
      offer={offer.data}
      status={!denied && !status.isError ? status.data : undefined}
      email={email}
      pending={pending}
      canRefresh={!denied}
      loading={
        offer.isPending || (stage === 'ready' && status.isPending && !denied)
      }
      error={
        error
          ? message(error, stage)
          : readError
          ? t(
              'Setup details could not be verified. Refresh to try again. No new trial has been granted by this screen.',
            )
          : null
      }
      notice={notice}
      cooldown={cooldown}
      captchaReady={!!captchaToken}
      challenge={challenge}
      brand={<FullLogo />}
      legalLinks={legalLinks}
      onSubmit={onSubmit}
      onStage={(value) => {
        attempt.current++;
        setStage(value);
        setError(null);
        setNotice(null);
      }}
      onResend={resend}
      onRefresh={() => {
        if (!denied) {
          void offer.refetch();
          if (stage === 'ready') void status.refetch();
        }
      }}
      onExit={() => {
        client.clear();
        authenticationSession.clearSession();
        navigate('/sign-in', { replace: true });
      }}
      onContinue={() => navigate('/')}
      onBilling={() => navigate('/platform/billing')}
    />
  );
}
function message(error: HostedAuthError['kind'], stage: AuthStage) {
  const messages = {
    session: t(
      'Your session changed or expired. Use another account to sign in again.',
    ),
    denied: t(
      'Your workspace access changed. Sign in again or contact a platform administrator.',
    ),
    verification: t(
      'This email needs verification. Use a sign-in code, or choose Finish email verification.',
    ),
    credentials: t(
      'The email or password could not be verified. Try again or use an email code.',
    ),
    code: t(
      'That code is invalid, expired or already used. Request a fresh code and try again.',
    ),
    rate: t('Too many attempts. Wait a moment before trying again.'),
    captcha: t(
      'Verification is unavailable or expired. Complete the verification challenge, or reload this page to try again.',
    ),
    trial: t(
      'A trial has already been used for this identity. Sign in to the existing workspace or contact support.',
    ),
    approval: t(
      'Email verification is complete. Ask the Sydekyks team to approve this email, then sign in again. You do not need to create another account.',
    ),
    unavailable:
      stage === 'verification'
        ? t(
            'Verification or setup could not be completed. Try signing in with the password you just set. If it was not saved, request a fresh verification code.',
          )
        : t(
            'The request could not be completed. If a code was already used, request a fresh one to resume the same workspace.',
          ),
  };
  return messages[error];
}
