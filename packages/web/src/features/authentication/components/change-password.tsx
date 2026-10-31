import { ResetPasswordRequestBody } from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useRef, useState } from 'react';
import { SubmitHandler, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { authenticationApi } from '@/api/authentication-api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Form, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { PasswordRequirementsList } from '@/features/authentication/components/password-validator';
import { passwordValidation } from '@/features/authentication/utils/password-validation-utils';
import { authenticationSession } from '@/lib/authentication-session';
import {
  getPasswordResetSecret,
  forgetPasswordResetSecret,
} from '@/lib/password-reset-secret';

import { authMutations } from '../hooks/auth-hooks';

const ChangePasswordForm = () => {
  const [resetSecret] = useState(getPasswordResetSecret);
  const [rejected, setRejected] = useState(false);
  const hasSecret =
    !!resetSecret &&
    ResetPasswordRequestBody.shape.identityId.safeParse(resetSecret.identityId)
      .success &&
    resetSecret.otp.length > 0 &&
    resetSecret.otp.length <= 128;
  const validation = useQuery({
    // Credentials stay in memory, never in a URL or query-cache key.
    queryKey: ['password-reset-validity'],
    queryFn: () => authenticationApi.validatePasswordReset(resetSecret!),
    enabled: hasSecret && !rejected,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (
    resetSecret &&
    hasSecret &&
    !rejected &&
    validation.isSuccess &&
    validation.data.valid &&
    !validation.isFetching
  ) {
    return (
      <VerifiedPasswordResetForm
        secret={resetSecret}
        onInvalid={() => {
          forgetPasswordResetSecret();
          setRejected(true);
        }}
      />
    );
  }
  const unavailable =
    !hasSecret || rejected || validation.data?.valid === false;
  return (
    <Card className="w-full max-w-md rounded-md">
      <CardHeader>
        <CardTitle className="text-2xl">
          {unavailable
            ? t('Reset link unavailable')
            : validation.isError
            ? t('Could not check reset link')
            : t('Checking reset link')}
        </CardTitle>
        <CardDescription
          role={unavailable || validation.isError ? 'alert' : 'status'}
        >
          {unavailable
            ? t(
                'This password reset link is missing, invalid or has expired. Request a new reset email to continue.',
              )
            : validation.isError
            ? t(
                'We could not check this link. Check your connection and try again.',
              )
            : t('Please wait while we check your password reset link.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {validation.isError && !unavailable && (
          <Button variant="outline" onClick={() => void validation.refetch()}>
            {t('Try again')}
          </Button>
        )}
        <Button asChild>
          <Link to="/forget-password">{t('Request a new reset email')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
};

const VerifiedPasswordResetForm = ({
  secret,
  onInvalid,
}: {
  secret: { identityId: string; otp: string };
  onInvalid: () => void;
}) => {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState('');
  const [isPasswordFocused, setPasswordFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const form = useForm<{
    otp: string;
    identityId: string;
    newPassword: string;
  }>({
    defaultValues: {
      otp: secret.otp,
      identityId: secret.identityId,
      newPassword: '',
    },
  });

  const { mutate, isPending } = authMutations.useResetPassword({
    onSuccess: () => {
      toast.success(t('Your password was changed successfully'), {
        duration: 3000,
      });
      forgetPasswordResetSecret();
      authenticationSession.clearSession();
      navigate('/sign-in');
    },
    onError: (error) => {
      if (error.response?.status === 401) {
        onInvalid();
        return;
      }
      setServerError(t('Could not reset your password. Try again shortly.'));
    },
  });

  const onSubmit: SubmitHandler<ResetPasswordRequestBody> = (data) => {
    mutate(data);
  };

  return (
    <Card className="w-full max-w-md rounded-md">
      <CardHeader>
        <CardTitle className="text-2xl">{t('Reset Password')}</CardTitle>
        <CardDescription>{t('Enter your new password')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form className="grid gap-2" onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="newPassword"
              rules={{
                required: t('Password is required'),
                validate: passwordValidation,
              }}
              render={({ field }) => (
                <FormItem
                  className="grid space-y-2"
                  onClick={() => inputRef?.current?.focus()}
                  onFocus={() => setPasswordFocused(true)}
                >
                  <Label htmlFor="newPassword">{t('Password')}</Label>
                  <Popover open={isPasswordFocused}>
                    <PopoverTrigger asChild>
                      <Input
                        {...field}
                        required
                        id="newPassword"
                        type="password"
                        autoComplete="new-password"
                        maxLength={64}
                        placeholder={'********'}
                        ref={inputRef}
                        onBlur={() => setPasswordFocused(false)}
                        onChange={(e) => field.onChange(e)}
                      />
                    </PopoverTrigger>
                    <PopoverContent className="absolute border-2 bg-gray-1 p-2 rounded-md right-60 -bottom-16 flex flex-col">
                      <PasswordRequirementsList
                        password={form.getValues().newPassword}
                        isSubmitted={form.formState.submitCount > 0}
                      />
                    </PopoverContent>
                  </Popover>
                  <FormMessage />
                </FormItem>
              )}
            />
            {serverError && <FormMessage>{serverError}</FormMessage>}
            <Button className="w-full mt-2" loading={isPending} type="submit">
              {t('Confirm')}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
};

export { ChangePasswordForm };
